import Foundation
import XCTest
@testable import IamrealApp

/// The back end and the card of web/test/app-backend.ts, which starts a
/// local Worker, runs these tests and then has Go's iamreal-verify
/// re-verify the proof log they wrote. It leaves what a test needs in
/// web/test-output/app/backend.json; without that file the tests that need
/// a back end are skipped (the other tests of this directory need none).
struct TestBackend {
    /// Where the Worker's front server listens: the site and the data domain in one.
    let origin: URL
    /// The time the Worker's clock started at.
    let start: Date
    /// The two issuer keys, in the shape idc_testing_session_open takes.
    let issuers: Data
    /// What the card returns (DER), in its order, and which of them signs.
    let certificates: [Data]
    let signing: Int
    /// The card's key: PKCS #1 RSAPrivateKey, DER.
    let privateKey: Data
    let pin: String

    static func load() throws -> TestBackend {
        // Not a file of the repository: the script writes it for the length of its run.
        guard let file = try? Data(contentsOf: Repository.root.appendingPathComponent("web/test-output/app/backend.json")) else {
            throw XCTSkip("no back end: run these tests through web/test/app-backend.ts (ios/README.md)")
        }
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: file) as? [String: Any])
        let time = ISO8601DateFormatter()
        time.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return TestBackend(
            origin: try XCTUnwrap(URL(string: try XCTUnwrap(json["origin"] as? String))),
            start: try XCTUnwrap(time.date(from: try XCTUnwrap(json["now"] as? String))),
            issuers: try JSONSerialization.data(withJSONObject: try XCTUnwrap(json["issuers"])),
            certificates: try XCTUnwrap(json["certificates"] as? [String]).map { try XCTUnwrap(Data(base64Encoded: $0)) },
            signing: try XCTUnwrap(json["signing"] as? Int),
            privateKey: try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(json["private_key"] as? String))),
            pin: try XCTUnwrap(json["pin"] as? String))
    }

    /// From now on the Worker's clock shows `time`.
    func setClock(_ time: Date) async throws {
        var request = URLRequest(url: origin.appendingPathComponent("__app-test/clock"))
        request.httpMethod = "PUT"
        request.httpBody = Data(ISO8601DateFormatter().string(from: time).utf8)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
    }

    /// A session of the core that trusts the back end's issuer keys in
    /// place of MOICA's: the library of the tests has the function, the
    /// library of an app for an iPhone does not.
    func openSession() throws -> DeviceCore.Session {
        var handle: idc_session = 0
        let code = issuers.withUnsafeBytes {
            idc_testing_session_open(UInt32(IDC_PROOF_LOG_TEST), $0.bindMemory(to: UInt8.self).baseAddress, $0.count, &handle)
        }
        guard code == IDC_OK else { throw DeviceCore.Failure(code: code) }
        return DeviceCore.Session(handle: handle)
    }
}

/// The CRL numbers of one test, in memory.
final class MemoryCRLNumbers: CRLNumbers {
    private var numbers: [String: String] = [:]

    func highest(for issuer: String) -> String? {
        numbers[issuer]
    }

    func remember(_ number: String, for issuer: String) {
        numbers[issuer] = number
    }
}

/// A back end that counts the requests for `config` on their way to the real one.
final class CountingBackend: Backend {
    private let backend: Backend
    private(set) var configRequests = 0
    /// The record does not reach the server: as a phone that lost the network.
    var submitFails = false
    /// The server does not answer when asked for its config.
    var configFails = false

    init(_ backend: Backend) {
        self.backend = backend
    }

    func config() async throws -> Data {
        configRequests += 1
        if configFails { throw BackendFailure(code: "network", requestID: nil) }
        return try await backend.config()
    }

    func crlIndex() async throws -> Data { try await backend.crlIndex() }
    func crl(sha256: String) async throws -> Data { try await backend.crl(sha256: sha256) }
    func cardState(_ body: Data) async throws -> Data { try await backend.cardState(body) }
    func challenge() async throws -> String { try await backend.challenge() }
    func submit(_ body: Data) async throws -> Data {
        if submitFails { throw BackendFailure(code: "network", requestID: nil) }
        return try await backend.submit(body)
    }
}
