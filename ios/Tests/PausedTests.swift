import Foundation
import XCTest
@testable import IamrealApp

/// The maintainer stopped taking card proofs (docs/api/card-proof.md,
/// `paused`; #394): step 1 says so in place of common.next; a `config` that
/// says so on the way stops step 2 before the card is read; `challenges`
/// and `records` answered `paused` stop with stops.paused and only a new
/// card proof. Against a fake back end: its `config` says `paused` or not,
/// and its `challenges` and `records` answer `paused`, as the Worker does
/// while card proofs are stopped.
@MainActor
final class PausedTests: XCTestCase {
    typealias Flow = CardProofFlow

    private var sentences: Copy!
    private var screens: Screens!

    override func setUpWithError() throws {
        sentences = Copy(json: try Repository.data("design/copy/card-proof.json"))
        screens = Screens(copy: sentences, appCopy: Copy(json: try Repository.data("design/copy/app.json")), host: "iamreal.tw")
    }

    /// The back end: `config` as `paused` says, counted; `challenges` and `records` answer `paused`.
    private final class PausedBackend: Backend {
        var paused: Bool
        /// What the start's config (`?start`) says, when not as `paused`.
        var pausedAtStart: Bool?
        private(set) var configs = 0

        init(paused: Bool) { self.paused = paused }

        func config(start: Bool) async throws -> Data {
            configs += 1
            let paused = start ? pausedAtStart ?? self.paused : self.paused
            return Data(#"{"paused":\#(paused),"crl_max_age_days":3,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]}"#.utf8)
        }

        func crlIndex() async throws -> Data { throw BackendFailure(code: "network", requestID: nil) }
        func crl(sha256: String) async throws -> Data { throw BackendFailure(code: "network", requestID: nil) }
        func cardState(_ body: Data) async throws -> Data { throw BackendFailure(code: "network", requestID: nil) }
        func challenge() async throws -> String { throw BackendFailure(code: "paused", requestID: "0123456789abcdef") }
        func submit(_ body: Data) async throws -> Data { throw BackendFailure(code: "paused", requestID: "0123456789abcdef") }
        func count(_ body: Data) async {}
    }

    private func model(_ backend: Backend) -> CardProofModel {
        let site = URL(string: "https://test.invalid")!
        return CardProofModel(CardProofModel.Dependencies(
            flow: Flow.Dependencies(
                proofLog: .test, backend: backend,
                card: NoCardReader(), clock: Date.init, crlNumbers: MemoryCRLNumbers(),
                openSession: { try DeviceCore.Session(.test) }, proofFiles: BundledFile.proofFiles(for:)),
            copy: Copy.bundled(), appCopy: Copy.bundled("app"),
            reminders: Reminders(store: MemoryReminderStore(), notifier: FakeNotifier(), clock: Date.init, calendar: .current),
            openSchedule: {}, openSettings: {}, site: site,
            open: { _ in }, copyText: { _ in }, share: { _ in }))
    }

    /// Waits for what the model does without a button: the config it asked for when the app opened.
    private func until(_ what: String, _ condition: () -> Bool) async throws {
        for _ in 0..<300 where !condition() { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(condition(), what)
    }

    private func says(_ screen: Screen, _ sentence: String) -> Bool { screen.blocks.contains(.message(sentence)) }

    private func why(_ screen: Screen) -> [String] {
        screen.blocks.compactMap { if case .items(let items) = $0 { return items.first { $0.state == .halted }?.why } else { return nil } }.first ?? []
    }

    func testConfigsPausedRead() {
        func config(_ paused: String?) -> Data {
            Data(("{" + (paused.map { #""paused":\#($0),"# } ?? "") + #""crl_max_age_days":3,"platforms":[]}"#).utf8)
        }
        XCTAssertEqual(Flow.paused(config("true")), true)
        XCTAssertEqual(Flow.paused(config("false")), false)
        XCTAssertEqual(Flow.paused(config(nil)), false)
        // There and neither true nor false (spec/device-checks.md).
        for other in ["1", "0", #""true""#, "null"] { XCTAssertNil(Flow.paused(config(other)), other) }
    }

    func testStepOneSaysSoInPlaceOfNext() async throws {
        let backend = PausedBackend(paused: true)
        let model = model(backend)
        XCTAssertEqual(model.screen.buttons.map(\.action), [.start], "before the config answers")
        model.open()
        try await until("step 1 says card proofs are stopped") { says(model.screen, copy("before.paused")) }
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertEqual(model.screen.buttons, [], "no common.next")
        // Resumed, and the app comes back to the front: asked again, and common.next is back.
        backend.paused = false
        model.cameBack()
        try await until("common.next again") { model.screen.buttons.map(\.action) == [.start] }
        XCTAssertFalse(says(model.screen, copy("before.paused")))
        XCTAssertEqual(backend.configs, 2)
    }

    func testStoppedAfterTheAppOpenedStepOneSaysSoWhenItOpensAgain() async throws {
        let backend = PausedBackend(paused: false)
        let model = model(backend)
        model.open()
        try await until("the config answered") { backend.configs == 1 }
        XCTAssertEqual(model.screen.buttons.map(\.action), [.start])
        // The maintainer stops card proofs; the cardholder presses 下一步, whose config (with the mark of a start) says so.
        backend.paused = true
        model.perform(.start)
        await model.work?.value
        try await until("step 1 says card proofs are stopped") { says(model.screen, copy("before.paused")) }
        XCTAssertEqual(model.screen.buttons, [])
        XCTAssertEqual(backend.configs, 2)
    }

    func testConfigSaysSoOnTheWayStepTwoStopsBeforeTheCard() async throws {
        let backend = PausedBackend(paused: true)
        // The start's config said nothing of it yet: stopped since.
        backend.pausedAtStart = false
        let model = model(backend)
        // Step 1 did not hear it yet (the config had not answered): step 2's first item stops.
        model.perform(.start)
        await model.work?.value
        model.perform(.readCard)
        await model.work?.value
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertEqual(why(model.screen), [copy("stops.paused")], "under 連上島民證明的伺服器, before the card (no app_stops.no_tap)")
        XCTAssertEqual(model.screen.buttons, [Button(label: copy("app_read.restart"), action: .readAgain)], "a new card proof, not the tap again")
        // Back at step 1, it says so; once resumed, a card proof asks again and goes on to the card.
        model.perform(.back)
        try await until("step 1 says card proofs are stopped") { says(model.screen, copy("before.paused")) }
        let asked = backend.configs
        backend.paused = false
        model.perform(.readAgain)
        model.perform(.readCard)
        await model.work?.value
        // The kept answer said paused: asked again at once, and the card proof goes on to the card (none comes here).
        XCTAssertEqual(backend.configs, asked + 1)
        XCTAssertEqual(why(model.screen), [copy("app_stops.no_tap", ["spot": copy("app_read.spot_iphone")])])
    }

    func testChallengesOrRecordsAnsweredPausedOnlyANewCardProof() {
        let stop = Flow.Stop.server(BackendFailure(code: "paused", requestID: "0123456789abcdef"))
        // challenges: step 5's first item; records: its last. Only 回到開頭: not progress.retry, it would be paused again.
        for reached in [0, 3] {
            let screen = screens.progress(reached: reached, stop: stop, submitFailed: false)
            XCTAssertEqual(why(screen), [copy("stops.paused"), copy("stops.request_id", ["request_id": "0123456789abcdef"])], "\(reached)")
            XCTAssertEqual(screen.buttons, [Button(label: copy("accounts.restart"), action: .restart)], "\(reached)")
        }
    }

    private func copy(_ key: String, _ values: [String: String] = [:]) -> String { sentences(key, values) }
}
