import Foundation
import Network
import XCTest
@testable import IamrealApp

/// What every request of the app calls itself (#444): one fixed value, the
/// same as Android's (android/…/backend/Backend.kt, USER_AGENT), in place
/// of the system's own, which names the app's build and the system's
/// version. Against a server on this machine that keeps the head of every
/// request it gets.
final class UserAgentTests: XCTestCase {
    /// Listens on this machine; answers every request with `status` and an
    /// empty JSON object, closes the connection, and keeps the request's head.
    private final class Recorder {
        let listener: NWListener
        private let lock = NSLock()
        private var kept: [String] = []

        /// The heads of the requests so far, in the order they came.
        var heads: [String] {
            lock.lock()
            defer { lock.unlock() }
            return kept
        }

        init() throws {
            listener = try NWListener(using: .tcp, on: .any)
        }

        /// Starts listening; the site's address.
        func start() async throws -> URL {
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .global())
                Recorder.readRequest(connection, Data()) { head in
                    self?.keep(head)
                    // 200 where the app expects it, and 201 for a record: the status is not what is looked at here.
                    let status = head.hasPrefix("POST /api/v1/records ") ? "201 Created" : "200 OK"
                    let answer = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
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

        private func keep(_ head: String) {
            lock.lock()
            kept.append(head)
            lock.unlock()
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

    /// The values of the header `name` in a request's head.
    private func values(of name: String, in head: String) -> [String] {
        head.components(separatedBy: "\r\n").dropFirst().compactMap { line in
            guard let colon = line.firstIndex(of: ":"), line[..<colon].lowercased() == name.lowercased() else { return nil }
            return line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
    }

    func testEveryRequestCallsItselfTheOneFixedName() async throws {
        let server = try Recorder()
        let site = try await server.start()
        defer { withExtendedLifetime(server) {} }
        let backend = HTTPBackend(site: site, publicFiles: site)

        // Every request the app makes (Backend): the answers are not what is looked at, so what each call makes of `{}` is let go.
        _ = try? await backend.config()
        _ = try? await backend.crlIndex()
        _ = try? await backend.crl(sha256: String(repeating: "0", count: 64))
        _ = try? await backend.cardState(Data("{}".utf8))
        _ = try? await backend.challenge()
        _ = try? await backend.submit(Data("{}".utf8))

        let heads = server.heads
        XCTAssertEqual(heads.map { $0.components(separatedBy: "\r\n")[0] }, [
            "GET /api/v1/config HTTP/1.1",
            "GET /crl/index.jsonl HTTP/1.1",
            "GET /crl/\(String(repeating: "0", count: 64)).crl HTTP/1.1",
            "POST /api/v1/card-state HTTP/1.1",
            "POST /api/v1/challenges HTTP/1.1",
            "POST /api/v1/records HTTP/1.1",
        ], "one request for each call, and no other")
        for head in heads {
            let request = head.components(separatedBy: "\r\n")[0]
            // Android's value, to the letter.
            XCTAssertEqual(values(of: "User-Agent", in: head), ["iamreal"], request)
            // Nothing of the app's version, the system's or the phone's anywhere in the head.
            for word in ["CFNetwork", "Darwin", "IamrealApp", "iPhone", "iOS"] {
                XCTAssertFalse(head.contains(word), "\(request): \(word) in \(head)")
            }
        }
    }
}
