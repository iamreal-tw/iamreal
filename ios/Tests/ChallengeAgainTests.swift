import Foundation
import Network
import XCTest
@testable import IamrealApp

/// The challenge asked for a second time (#404): a request that went out
/// and got no head of an answer is made once more, and only for
/// `POST /api/v1/challenges`. Against a server on this machine that reads
/// each request and then answers it, or closes the connection without a
/// byte, as a connection that went dead while the phone waited on steps 4
/// and 5 does.
final class ChallengeAgainTests: XCTestCase {
    private static let challenge = #"{"challenge":"2026-11-16.AAAA"}"#
    private static let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(challenge.utf8.count)\r\nConnection: close\r\n\r\n\(challenge)"

    /// Listens on this machine. Each connection in turn gets the next of
    /// `answers`: bytes to write, or nil to close with the request read and
    /// nothing written.
    private final class Server {
        let listener: NWListener
        private let answers: [String?]
        private let lock = NSLock()
        private var served = 0
        private var lines: [String] = []

        /// The first line of each request that came, in order.
        var requests: [String] { lock.withLock { lines } }

        init(_ answers: [String?]) throws {
            listener = try NWListener(using: .tcp, on: .any)
            self.answers = answers
        }

        func start() async throws -> URL {
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .global())
                Server.readRequest(connection, Data()) { head in
                    guard let self else { return connection.cancel() }
                    let answer: String? = self.lock.withLock {
                        defer { self.served += 1 }
                        if let first = head.split(separator: "\r\n").first { self.lines.append(String(first)) }
                        return self.served < self.answers.count ? self.answers[self.served] : nil
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

        /// Reads the request's head and as many bytes as its Content-Length says, then `then` with the head.
        private static func readRequest(_ connection: NWConnection, _ got: Data, then: @escaping (String) -> Void) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                let all = got + (data ?? Data())
                if let end = all.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(decoding: all[..<end.lowerBound], as: UTF8.self)
                    let length = head.lowercased().split(separator: "\r\n").first { $0.hasPrefix("content-length:") }
                        .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
                    if all.count - end.upperBound >= length { return then(head) }
                }
                if isComplete || error != nil { return then(String(decoding: all, as: UTF8.self)) }
                readRequest(connection, all, then: then)
            }
        }

        deinit { listener.cancel() }
    }

    private let post = "POST /api/v1/challenges HTTP/1.1"

    /// The failure of `ask`, which must be the code `network`.
    private func assertNetwork(_ what: String, _ ask: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await ask()
            XCTFail("\(what): an answer", file: file, line: line)
        } catch let failure as BackendFailure {
            XCTAssertEqual(failure.code, "network", what, file: file, line: line)
        } catch {
            XCTFail("\(what): \(error)", file: file, line: line)
        }
    }

    func testAChallengeThatGotNoAnswerIsAskedForOnceMoreAndTheSecondAnswerIsTheChallenge() async throws {
        let server = try Server([nil, Self.ok])
        let site = try await server.start()
        let challenge = try await HTTPBackend(site: site, publicFiles: site).challenge()
        XCTAssertEqual(challenge, "2026-11-16.AAAA")
        XCTAssertEqual(server.requests, [post, post])
    }

    func testOnceMoreOnlyASecondRequestWithoutAnAnswerIsNoAnswer() async throws {
        let server = try Server([nil, nil, Self.ok])
        let site = try await server.start()
        await assertNetwork("two requests unanswered") { _ = try await HTTPBackend(site: site, publicFiles: site).challenge() }
        XCTAssertEqual(server.requests, [post, post])
    }

    func testAnAnswerWhateverItSaysIsNotAskedForAgain() async throws {
        let refused = #"{"error":"rate_limited"}"#
        let server = try Server(["HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: \(refused.utf8.count)\r\nConnection: close\r\n\r\n\(refused)", Self.ok])
        let site = try await server.start()
        do {
            _ = try await HTTPBackend(site: site, publicFiles: site).challenge()
            XCTFail("a refusal read as a challenge")
        } catch let failure as BackendFailure {
            XCTAssertEqual(failure.code, "rate_limited")
        }
        XCTAssertEqual(server.requests, [post])
    }

    func testASubmissionAndTheCardsStateAreSentOnceAnswerOrNone() async throws {
        let body = Data("{}".utf8)
        let submissions = try Server([nil, Self.ok])
        let submitTo = try await submissions.start()
        await assertNetwork("a submission") { _ = try await HTTPBackend(site: submitTo, publicFiles: submitTo).submit(body) }
        XCTAssertEqual(submissions.requests, ["POST /api/v1/records HTTP/1.1"])
        let states = try Server([nil, Self.ok])
        let stateOf = try await states.start()
        await assertNetwork("the card's state") { _ = try await HTTPBackend(site: stateOf, publicFiles: stateOf).cardState(body) }
        XCTAssertEqual(states.requests, ["POST /api/v1/card-state HTTP/1.1"])
    }
}
