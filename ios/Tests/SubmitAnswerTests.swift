import Foundation
import Network
import XCTest
@testable import IamrealApp

/// The answer to a submission (#264): a 201 is a record in the proof log
/// whatever follows it (spec/records-response.md). A body cut short, or
/// longer than the app reads (1 MiB), is no bytes, not a failure: the done
/// screen then says only that the proof log recorded the card proof
/// (`done.recorded_only`, which the vectors' empty body gives:
/// DoneScreenTests). Against a server on this machine that answers one
/// request with bytes written by hand, so the body can stop where a network
/// would cut it.
final class SubmitAnswerTests: XCTestCase {
    private let mib = 1 << 20

    /// Listens on this machine; answers the one request it gets with `head`
    /// and then `body`, and closes the connection.
    private final class OneAnswer {
        let listener: NWListener
        let answer: Data

        init(head: String, body: Data) throws {
            listener = try NWListener(using: .tcp, on: .any)
            answer = Data(head.utf8) + body
        }

        /// Starts listening; the site's address.
        func start() async throws -> URL {
            listener.newConnectionHandler = { [answer] connection in
                connection.start(queue: .global())
                OneAnswer.readRequest(connection, Data()) {
                    connection.send(content: answer, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
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

        /// Reads the request's head and as many bytes as its Content-Length says, then `then`.
        private static func readRequest(_ connection: NWConnection, _ got: Data, then: @escaping () -> Void) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                let all = got + (data ?? Data())
                if let end = all.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(decoding: all[..<end.lowerBound], as: UTF8.self).lowercased()
                    let length = head.split(separator: "\r\n").first { $0.hasPrefix("content-length:") }
                        .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
                    if all.count - end.upperBound >= length { return then() }
                }
                if isComplete || error != nil { return then() }
                readRequest(connection, all, then: then)
            }
        }

        deinit { listener.cancel() }
    }

    private func submit(head: String, body: Data) async throws -> Data {
        let server = try OneAnswer(head: head, body: body)
        let site = try await server.start()
        // The server stays up until the answer is read: it is stopped (deinit) after this line.
        defer { withExtendedLifetime(server) {} }
        return try await HTTPBackend(site: site, publicFiles: site).submit(Data("{}".utf8))
    }

    private func created(_ length: Int) -> String {
        "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: \(length)\r\nConnection: close\r\n\r\n"
    }

    /// What the done screen is given for those bytes: nothing told, so it says only that it was recorded.
    private func assertNothingTold(_ answer: Data, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(CardProofFlow.Answer.read(answer, rows: Data("[]".utf8)), .nothing, file: file, line: line)
    }

    func testA201WhoseBodyStopsInTheMiddleIsNoBytesNotNetwork() async throws {
        // Sent in chunks, cut in the middle of one: a chunk of 1000 bytes announced, 10 sent, and the connection closed.
        let head = "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        let answer: Data
        do {
            answer = try await submit(head: head, body: Data("3e8\r\n".utf8) + Data(repeating: UInt8(ascii: "{"), count: 10))
        } catch let failure as BackendFailure {
            return XCTFail("a 201 cut short is a record made, not \(failure.code)")
        }
        XCTAssertEqual(answer.count, 0)
        assertNothingTold(answer)
    }

    func testA201WhoseBodyIsLongerThanOneMiBIsNoBytesNotNetwork() async throws {
        let answer: Data
        do {
            answer = try await submit(head: created(mib + 1), body: Data(repeating: UInt8(ascii: " "), count: mib + 1))
        } catch let failure as BackendFailure {
            return XCTFail("a 201 too long to read is a record made, not \(failure.code)")
        }
        XCTAssertEqual(answer.count, 0)
        assertNothingTold(answer)
    }

    func testA201OfExactlyOneMiBAndOneWholeGiveTheirBytes() async throws {
        let whole = Data(#"{"seq":1}"#.utf8)
        let got = try await submit(head: created(whole.count), body: whole)
        XCTAssertEqual(got, whole)
        let most = Data(repeating: UInt8(ascii: " "), count: mib)
        let gotMost = try await submit(head: created(most.count), body: most)
        XCTAssertEqual(gotMost, most)
    }

    func testARefusalIsStillARefusalWithItsCode() async throws {
        let body = Data(#"{"error":"paused"}"#.utf8)
        do {
            _ = try await submit(head: "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n", body: body)
            XCTFail("a 503 was taken for a record")
        } catch let failure as BackendFailure {
            XCTAssertEqual(failure.code, "paused")
        }
    }
}
