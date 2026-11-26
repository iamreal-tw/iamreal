import Foundation

/// The back end, as the card proof uses it (docs/api/card-proof.md): the
/// site's API and the files of the CRL archive on the data domain
/// (ADR-0027). Bodies go in and out as bytes: the core writes the requests
/// and reads the answers, not this file.
protocol Backend {
    /// GET /api/v1/config: the body.
    func config() async throws -> Data
    /// The index of the CRL archive: the body of crl/index.jsonl.
    func crlIndex() async throws -> Data
    /// One CRL of the archive: the body of crl/<sha256>.crl.
    func crl(sha256: String) async throws -> Data
    /// POST /api/v1/card-state with `body`: the answer's body.
    func cardState(_ body: Data) async throws -> Data
    /// POST /api/v1/challenges: the challenge, as the server issued it.
    func challenge() async throws -> String
    /// POST /api/v1/records with `body`. Returns when the server answered
    /// 201: the record is in the proof log. The answer's body, as it came;
    /// the core reads it (spec/records-response.md).
    func submit(_ body: Data) async throws -> Data
}

/// The back end did not give what was asked for.
struct BackendFailure: Error, Equatable {
    /// The server's error code, `http_<status>` when it gave none,
    /// `malformed_response` for an answer that cannot be read, `network`
    /// when there was no answer.
    let code: String
    /// The answer's X-Request-Id, for the cardholder to report.
    let requestID: String?
}

/// The back end over HTTPS. The two hosts are fixed when the app is built
/// (AppEnvironment); a test gives it the address of a local Worker.
///
/// No request carries a cookie, a cache or an identifier of the device,
/// and nothing is stored: the session is ephemeral. Two headers the system
/// would fill with what differs from phone to phone are fixed: User-Agent
/// (the system's has the app's build and the system's version) and
/// Accept-Language (the system's is the phone's list of languages). The
/// others the system adds (Accept, Accept-Encoding, Connection) had, when
/// measured, values that name nothing of the phone (UserAgentTests).
struct HTTPBackend: Backend {
    let site: URL
    let publicFiles: URL
    private let session: URLSession

    init(site: URL, publicFiles: URL) {
        self.site = site
        self.publicFiles = publicFiles
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        // In place of the system's own, which name the app's build, the system's version and the phone's languages (#444).
        configuration.httpAdditionalHeaders = ["User-Agent": Self.userAgent, "Accept-Language": Self.acceptLanguage]
        configuration.timeoutIntervalForRequest = 30
        // A CRL is tens of megabytes.
        configuration.timeoutIntervalForResource = 5 * 60
        session = URLSession(configuration: configuration)
    }

    func config() async throws -> Data {
        try await api("GET", "api/v1/config", body: nil, expecting: 200)
    }

    func crlIndex() async throws -> Data {
        try await file("crl/index.jsonl")
    }

    func crl(sha256: String) async throws -> Data {
        // The name comes from the index, which a server wrote: only a SHA-256 in hex is a file's name.
        guard sha256.utf8.count == 64, sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw BackendFailure(code: "malformed_response", requestID: nil)
        }
        return try await file("crl/\(sha256).crl")
    }

    func cardState(_ body: Data) async throws -> Data {
        try await api("POST", "api/v1/card-state", body: body, expecting: 200)
    }

    func challenge() async throws -> String {
        let body = try await api("POST", "api/v1/challenges", body: nil, expecting: 200)
        guard let answer = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let challenge = answer["challenge"] as? String
        else { throw BackendFailure(code: "malformed_response", requestID: nil) }
        return challenge
    }

    func submit(_ body: Data) async throws -> Data {
        var request = URLRequest(url: site.appendingPathComponent("api/v1/records"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The status first, then the body: a 201 is a record in the proof log
        // whatever follows it (spec/records-response.md), so a body that
        // does not arrive whole is no bytes, not a failure.
        let bytes: URLSession.AsyncBytes
        let response: HTTPURLResponse
        do {
            let (stream, answer) = try await session.bytes(for: request)
            guard let http = answer as? HTTPURLResponse else { throw BackendFailure(code: "network", requestID: nil) }
            (bytes, response) = (stream, http)
        } catch let failure as BackendFailure {
            throw failure
        } catch {
            throw BackendFailure(code: "network", requestID: nil)
        }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > Self.mostOfAnAnswer { throw BackendFailure(code: "network", requestID: nil) }
            }
        } catch {
            data = Data()
        }
        guard response.statusCode == 201 else {
            throw BackendFailure(code: Self.errorCode(data) ?? "http_\(response.statusCode)", requestID: Self.requestID(response))
        }
        return data
    }

    /// What every request calls itself: the same for every phone and every
    /// version of the app, and the same as Android's (Backend.kt, USER_AGENT).
    static let userAgent = "iamreal"

    /// The one language every request names, whatever the phone's
    /// languages are: URLSession sends the header in any case (an empty
    /// value goes out as an empty header), and the back end does not read it.
    static let acceptLanguage = "zh-TW"

    /// The most the app reads of the answer to a submission: 1 MiB.
    private static let mostOfAnAnswer = 1 << 20

    private func api(_ method: String, _ path: String, body: Data?, expecting status: Int) async throws -> Data {
        var request = URLRequest(url: site.appendingPathComponent(path))
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await send(request)
        guard response.statusCode == status else {
            throw BackendFailure(code: Self.errorCode(data) ?? "http_\(response.statusCode)", requestID: Self.requestID(response))
        }
        return data
    }

    private func file(_ path: String) async throws -> Data {
        let (data, response) = try await send(URLRequest(url: publicFiles.appendingPathComponent(path)))
        guard response.statusCode == 200 else {
            throw BackendFailure(code: "http_\(response.statusCode)", requestID: nil)
        }
        return data
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw BackendFailure(code: "network", requestID: nil) }
            return (data, http)
        } catch let failure as BackendFailure {
            throw failure
        } catch {
            throw BackendFailure(code: "network", requestID: nil)
        }
    }

    /// The `error` of an answer that is not the expected one: a short code
    /// of lowercase letters and `_`, or nothing.
    private static func errorCode(_ body: Data) -> String? {
        guard let answer = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let code = answer["error"] as? String,
              (1...40).contains(code.utf8.count),
              code.utf8.allSatisfy({ (97...122).contains($0) || $0 == 95 })
        else { return nil }
        return code
    }

    /// The server's request ID: hex digits, or nothing is shown.
    private static func requestID(_ response: HTTPURLResponse) -> String? {
        guard let id = response.value(forHTTPHeaderField: "X-Request-Id"),
              (1...64).contains(id.utf8.count),
              id.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { return nil }
        return id
    }
}
