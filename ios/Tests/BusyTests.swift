import Foundation
import Network
import XCTest
@testable import IamrealApp

/// Too many people (ADR-0026; docs/api/card-proof.md, `config` and "Rules
/// for every endpoint"; #420), without a back end: the request of the start
/// carries the mark (`?start`) and a 429 or a 503 `busy` is read as too many;
/// the start turned away keeps step 1, which says so, and no card is tapped;
/// a `config` without the mark turned away on the way is not a stop, the
/// card proof goes on with the start's; the card's state, the challenge and
/// the submission turned away say stops.too_many with 再試一次.
/// CardProofTests goes through the same with a card and the Worker.
@MainActor
final class BusyTests: XCTestCase {
    typealias Flow = CardProofFlow

    private var sentences: Copy!
    private var screens: Screens!

    override func setUpWithError() throws {
        sentences = Copy(json: try Repository.data("design/copy/card-proof.json"))
        screens = Screens(copy: sentences, appCopy: Copy(json: try Repository.data("design/copy/app.json")), host: "iamreal.tw")
    }

    private func copy(_ key: String, _ values: [String: String] = [:]) -> String { sentences(key, values) }

    private static let rateLimited = CountingBackend.rateLimited
    private static let busy = CountingBackend.busy

    // The requests ----------------------------------------------------------------------

    /// Answers each connection in turn with the next of `answers`, and keeps the first line of each request.
    private final class Server {
        let listener: NWListener
        private let answers: [String]
        private let lock = NSLock()
        private var lines: [String] = []

        var requests: [String] { lock.withLock { lines } }

        init(_ answers: [String]) throws {
            listener = try NWListener(using: .tcp, on: .any)
            self.answers = answers
        }

        func start() async throws -> URL {
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .global())
                connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, _, _ in
                    guard let self, let first = String(decoding: data ?? Data(), as: UTF8.self).split(separator: "\r\n").first, first.hasSuffix("HTTP/1.1") else { return connection.cancel() }
                    let answer: String? = self.lock.withLock {
                        self.lines.append(String(first))
                        return self.lines.count <= self.answers.count ? self.answers[self.lines.count - 1] : nil
                    }
                    guard let answer else { return connection.cancel() }
                    connection.send(content: Data(answer.utf8), isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
                }
            }
            let port: UInt16 = try await withCheckedThrowingContinuation { done in
                var resumed = false
                listener.stateUpdateHandler = { [listener] state in
                    guard !resumed else { return }
                    switch state {
                    case .ready:
                        resumed = true
                        done.resume(returning: listener.port!.rawValue)
                    case let .failed(error):
                        resumed = true
                        done.resume(throwing: error)
                    default:
                        break
                    }
                }
                listener.start(queue: .global())
            }
            return URL(string: "http://localhost:\(port)")!
        }

        deinit { listener.cancel() }
    }

    private static func answer(_ status: Int, _ reason: String, _ body: String) -> String {
        "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nRetry-After: 60\r\nX-Request-Id: 0123456789abcdef\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
    }

    func testTheStartCarriesTheMarkAndTooManyIsReadFromTheStatus() async throws {
        let server = try Server([
            Self.answer(503, "Service Unavailable", #"{"error":"busy"}"#),
            Self.answer(429, "Too Many Requests", #"{"error":"rate_limited"}"#),
            Self.answer(503, "Service Unavailable", #"{"error":"unavailable"}"#),
        ])
        let site = try await server.start()
        let backend = HTTPBackend(site: site, publicFiles: site)
        var failures: [BackendFailure] = []
        for start in [true, false, true] {
            do {
                _ = try await backend.config(start: start)
                XCTFail("an answer")
            } catch let failure as BackendFailure {
                failures.append(failure)
            }
        }
        XCTAssertEqual(server.requests, ["GET /api/v1/config?start HTTP/1.1", "GET /api/v1/config HTTP/1.1", "GET /api/v1/config?start HTTP/1.1"])
        XCTAssertEqual(failures.map(\.code), ["busy", "rate_limited", "unavailable"])
        XCTAssertEqual(failures.map(\.tooMany), [true, true, false], "a 503 that is not busy is not too many people")
        XCTAssertEqual(failures.map(\.requestID), ["0123456789abcdef", "0123456789abcdef", "0123456789abcdef"])
    }

    // Step 1 and the reading --------------------------------------------------------------

    /// `config` with the mark answered or turned away as the test says, and without it as `plain` says; the CRL never comes.
    private final class BusyBackend: Backend {
        var start: BackendFailure?
        var plain: BackendFailure?
        private(set) var asked: [Bool] = []

        func config(start: Bool) async throws -> Data {
            asked.append(start)
            if let failure = start ? self.start : plain { throw failure }
            return Data(#"{"paused":false,"crl_max_age_days":3,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]}"#.utf8)
        }

        func crlIndex() async throws -> Data { throw BackendFailure(code: "network", requestID: nil) }
        func crl(sha256: String) async throws -> Data { throw BackendFailure(code: "network", requestID: nil) }
        func cardState(_ body: Data) async throws -> Data { throw BackendFailure(code: "network", requestID: nil) }
        func challenge() async throws -> String { throw BackendFailure(code: "network", requestID: nil) }
        func submit(_ body: Data) async throws -> Data { throw BackendFailure(code: "network", requestID: nil) }
    }

    /// A card that is never there, and counts the taps that looked for it.
    private final class CountedNoCard: Card {
        private(set) var taps = 0

        func tap<T>(_ purpose: TapPurpose, _ body: (CardConnection) async throws -> T) async throws -> T {
            taps += 1
            throw CardFailure.noTap
        }
    }

    private func model(_ backend: Backend, _ card: Card) -> CardProofModel {
        let site = URL(string: "https://test.invalid")!
        return CardProofModel(CardProofModel.Dependencies(
            flow: Flow.Dependencies(
                proofLog: .test, backend: backend,
                card: card, clock: Date.init, crlNumbers: MemoryCRLNumbers(),
                openSession: { try DeviceCore.Session(.test) }, proofFiles: BundledFile.proofFiles(for:)),
            copy: Copy.bundled(), appCopy: Copy.bundled("app"),
            reminders: Reminders(store: MemoryReminderStore(), notifier: FakeNotifier(), clock: Date.init, calendar: .current),
            openSchedule: {}, openNotificationSettings: {}, openSettings: {}, site: site,
            open: { _ in }, copyText: { _ in }, share: { _ in }))
    }

    private func perform(_ action: Action, on model: CardProofModel) async {
        model.perform(action)
        while let work = model.work { await work.value }
    }

    private func why(_ screen: Screen) -> [String] {
        screen.blocks.compactMap { if case .items(let items) = $0 { return items.first { $0.state == .halted }?.why } else { return nil } }.first ?? []
    }

    func testTheStartTurnedAwayStaysAtStepOneAndNoCardIsTapped() async throws {
        for failure in [Self.busy, Self.rateLimited] {
            let backend = BusyBackend()
            backend.start = failure
            let card = CountedNoCard()
            let model = model(backend, card)
            await perform(.start, on: model)
            XCTAssertEqual(model.screen.step, 1, failure.code)
            XCTAssertEqual(Array(model.screen.texts.suffix(2)), [copy("before.busy"), copy("common.next")], "\(failure.code): right above 下一步, which stays")
            // Nothing on the screen reads a card: 下一步 is its one button.
            XCTAssertEqual(model.screen.buttons.map(\.action), [.start], failure.code)
            XCTAssertEqual(card.taps, 0, "\(failure.code): no card tapped")
            XCTAssertEqual(backend.asked, [true], failure.code)
            // Pressed again once the server lets it: on to step 2, the sentence gone.
            backend.start = nil
            await perform(.start, on: model)
            XCTAssertEqual(model.screen.step, 2, failure.code)
        }
    }

    func testTheReadingsConfigTurnedAwayGoesOnWithTheStarts() async throws {
        let backend = BusyBackend()
        backend.plain = Self.rateLimited
        let card = CountedNoCard()
        let model = model(backend, card)
        await perform(.start, on: model)
        XCTAssertEqual(model.screen.step, 2)
        await perform(.readCard, on: model)
        // On to the card, which never comes here: not a stop of the server.
        XCTAssertEqual(card.taps, 1)
        XCTAssertEqual(why(model.screen), [copy("app_stops.no_tap", ["spot": copy("app_read.spot_iphone")])])
        XCTAssertEqual(backend.asked.first, true)
        XCTAssertTrue(backend.asked.dropFirst().contains(false), "the reading asked config without the mark")
    }

    func testWithNoStartsToGoOnWithTheReadingsConfigTurnedAwayStopsBeforeTheCard() async throws {
        let backend = BusyBackend()
        // The start got no answer: nothing to fall back on.
        backend.start = BackendFailure(code: "network", requestID: nil)
        backend.plain = Self.busy
        let card = CountedNoCard()
        let model = model(backend, card)
        await perform(.start, on: model)
        XCTAssertEqual(model.screen.step, 2, "no answer to the start: on to step 2")
        await perform(.readCard, on: model)
        XCTAssertEqual(card.taps, 0)
        XCTAssertEqual(why(model.screen), [copy("stops.too_many"), copy("stops.request_id", ["request_id": "0123456789abcdef"])])
    }

    // Steps 3 and 5 -------------------------------------------------------------------------

    func testTheCardsStateTurnedAwayIsAskedAgain() {
        let screen = screens.pin(name: "王小明", state: .retry(screens.message(.server(Self.busy), tap: 2)))
        XCTAssertTrue(screen.blocks.contains(.message(copy("stops.too_many"))))
        XCTAssertEqual(screen.buttons, [Button(label: copy("common.back"), action: .back), Button(label: copy("progress.retry"), action: .retryCardState)])
    }

    func testTheChallengeOrTheRecordTurnedAwayIsAskedOrSentAgain() {
        for failure in [Self.rateLimited, Self.busy] {
            // The challenge: step 5's first item; 再試一次 asks again, then the card signs.
            let challenge = screens.progress(reached: 0, stop: .server(failure), submitFailed: false)
            XCTAssertEqual(why(challenge), [copy("stops.too_many"), copy("stops.request_id", ["request_id": "0123456789abcdef"])], failure.code)
            XCTAssertEqual(challenge.buttons, [Button(label: copy("progress.retry"), action: .declare)], failure.code)
            XCTAssertEqual(challenge.cancel?.label, copy("common.cancel"), failure.code)
            // The record: its last; the same record again, not the sentence of a submission that failed.
            let record = screens.progress(reached: 3, stop: .server(failure), submitFailed: true)
            XCTAssertEqual(why(record).first, copy("stops.too_many"), failure.code)
            XCTAssertEqual(record.buttons, [Button(label: copy("progress.retry"), action: .submitAgain)], failure.code)
            XCTAssertEqual(record.cancel?.label, copy("common.cancel"), failure.code)
        }
    }
}
