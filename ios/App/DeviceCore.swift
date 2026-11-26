import Foundation

/// The C functions of device-core/ (ADR-0034), as Swift: bytes in, bytes
/// out. Every buffer the core hands back is copied into a `Data` and given
/// back to the core, which overwrites it, before the call returns.
///
/// Nothing here takes a PIN. A call returns when its work is done; one
/// that takes long belongs on a background thread.
///
/// The `Data` a function returns is the caller's, and is not overwritten
/// when it goes away. Most of it is public or goes to the server as it is
/// (a scope string, a request's body). The one that is not is the answer
/// of `Session.checkCertificates`, which holds the name on the card: the
/// caller overwrites it once the name is read (CardProofFlow).
enum DeviceCore {
    /// Which proof log: the app is built for one (AppEnvironment).
    enum ProofLog {
        case production
        case test

        fileprivate var number: UInt32 {
            switch self {
            case .production: return UInt32(IDC_PROOF_LOG_PRODUCTION)
            case .test: return UInt32(IDC_PROOF_LOG_TEST)
            }
        }
    }

    /// A call that did not return IDC_OK. It carries the code and nothing
    /// read from a card, a certificate, a revocation list or an account.
    struct Failure: Error, Equatable {
        let code: Int32
    }

    /// IDC_ABI_VERSION of the library that is linked.
    static var linkedABIVersion: UInt32 { idc_abi_version() }
    /// IDC_ABI_VERSION of the header this file was compiled against.
    static var headerABIVersion: UInt32 { UInt32(IDC_ABI_VERSION) }

    /// Checks that the Barretenberg linked into the library answers.
    static func selfCheck() throws {
        let code = idc_self_check()
        guard code == IDC_OK else { throw Failure(code: code) }
    }

    /// The scope string a card signs for `proofLog`: 31 bytes.
    static func scopeString(_ proofLog: ProofLog) throws -> Data {
        try output { idc_scope_string(proofLog.number, $0) }
    }

    /// The declaration code of a list and a challenge: 31 bytes, the second
    /// message the card signs. `accounts` is the JSON of the list as
    /// `listConsequence` returned it.
    static func declarationCode(_ proofLog: ProofLog, accounts: Data, challenge: Data) throws -> Data {
        try accounts.withUnsafeBytes { a in
            try challenge.withUnsafeBytes { c in
                try output { idc_declaration_code(proofLog.number, a.bytes, a.count, c.bytes, c.count, $0) }
            }
        }
    }

    /// What a list does on every platform (idc_list_consequence): JSON.
    static func listConsequence(platforms: Data, cardState: Data, knownPlatforms: Data, accounts: Data, now: Date) throws -> Data {
        try platforms.withUnsafeBytes { p in
            try cardState.withUnsafeBytes { s in
                try knownPlatforms.withUnsafeBytes { k in
                    try accounts.withUnsafeBytes { a in
                        try output {
                            idc_list_consequence(p.bytes, p.count, s.bytes, s.count, k.bytes, k.count, a.bytes, a.count, seconds(now), $0)
                        }
                    }
                }
            }
        }
    }

    /// The state of a card for the screen of its accounts (idc_card_status): JSON.
    static func cardStatus(platforms: Data, cardState: Data, knownPlatforms: Data, now: Date) throws -> Data {
        try platforms.withUnsafeBytes { p in
            try cardState.withUnsafeBytes { s in
                try knownPlatforms.withUnsafeBytes { k in
                    try output { idc_card_status(p.bytes, p.count, s.bytes, s.count, k.bytes, k.count, seconds(now), $0) }
                }
            }
        }
    }

    /// The short ID of a scoped ID: its first 10 characters.
    static func shortID(of scopedID: String) throws -> String {
        let text = Data(scopedID.utf8)
        let short = try text.withUnsafeBytes { t in try output { idc_short_id(t.bytes, t.count, $0) } }
        return String(decoding: short, as: UTF8.self)
    }

    /// The answer to a submission as the steps after it tell it
    /// (idc_records_response): JSON. `response` is the body of the
    /// server's 201 as it sent it, `rows` the rows of listConsequence for
    /// the list the card signed. A body the core cannot read is not a
    /// failure: the record is in the proof log.
    static func recordsResponse(_ response: Data, rows: Data) throws -> Data {
        try response.withUnsafeBytes { a in
            try rows.withUnsafeBytes { r in
                try output { idc_records_response(a.bytes, a.count, r.bytes, r.count, $0) }
            }
        }
    }

    /// One card proof in progress in the core (the header, "A session").
    /// The core keeps what it checked; this holds the number that names
    /// it and closes the session when it goes away, which overwrites the
    /// certificate and everything computed from it.
    final class Session {
        private let handle: idc_session

        /// A session of the app: it checks against MOICA's keys.
        convenience init(_ proofLog: ProofLog) throws {
            var handle: idc_session = 0
            let code = idc_session_open(proofLog.number, &handle)
            guard code == IDC_OK else { throw Failure(code: code) }
            self.init(handle: handle)
        }

        /// Takes over a session that is open already.
        init(handle: idc_session) {
            self.handle = handle
        }

        deinit {
            idc_session_close(handle)
        }

        /// Adds one certificate the card returned (DER), in the card's order.
        func add(certificate: Data) throws {
            let code = certificate.withUnsafeBytes { idc_session_add_certificate(handle, $0.bytes, $0.count) }
            guard code == IDC_OK else { throw Failure(code: code) }
        }

        /// Step 1: chooses and checks the certificate. JSON; it holds the name on the card.
        func checkCertificates(now: Date) throws -> Data {
            try output { idc_session_check_certificates(handle, seconds(now), $0) }
        }

        /// Step 2, first half: which file of the archive. JSON.
        func chooseCRL(index: Data) throws -> Data {
            try index.withUnsafeBytes { i in try output { idc_session_choose_crl(handle, i.bytes, i.count, $0) } }
        }

        /// Step 2, second half: the file, and whether the certificate is on it. JSON.
        func checkCRL(_ crl: Data, config: Data, highest: String?) throws -> Data {
            let highest = Data((highest ?? "").utf8)
            return try crl.withUnsafeBytes { c in
                try config.withUnsafeBytes { g in
                    try highest.withUnsafeBytes { h in
                        try output { idc_session_check_crl(handle, c.bytes, c.count, g.bytes, g.count, h.bytes, h.count, $0) }
                    }
                }
            }
        }

        /// Step 3: builds the tree and the path. Takes a while.
        func buildTree() throws {
            let code = idc_session_build_tree(handle)
            guard code == IDC_OK else { throw Failure(code: code) }
        }

        /// Step 4: the files the app carries are the ones written into the core.
        func checkArtifacts(_ files: ProofFiles) throws {
            let code = files.with { c, v, g1, g2 in
                idc_session_check_artifacts(handle, c.bytes, c.count, v.bytes, v.count, g1.bytes, g1.count, g2.bytes, g2.count)
            }
            guard code == IDC_OK else { throw Failure(code: code) }
        }

        /// The date conditions again, on the date of `now`. JSON.
        func checkDate(now: Date) throws -> Data {
            try output { idc_session_check_date(handle, seconds(now), $0) }
        }

        /// The challenge the server issued: in its one spelling and dated today in
        /// Taiwan; if midnight passed since the checks, the date conditions again.
        /// The proof is made for the challenge it took only.
        func checkChallenge(now: Date, challenge: Data) throws -> Data {
            try challenge.withUnsafeBytes { c in
                try output { idc_session_check_challenge(handle, seconds(now), c.bytes, c.count, $0) }
            }
        }

        /// The body of POST /api/v1/card-state, from the card's signature over the scope string.
        func cardStateRequest(now: Date, scopeSignature: Data) throws -> Data {
            try scopeSignature.withUnsafeBytes { s in
                try output { idc_session_card_state_request(handle, seconds(now), s.bytes, s.count, $0) }
            }
        }

        /// The body of POST /api/v1/records, with the proof. Takes seconds.
        func recordsRequest(_ files: ProofFiles, accounts: Data, challenge: Data, scopeSignature: Data, declarationCodeSignature: Data) throws -> Data {
            try accounts.withUnsafeBytes { a in
                try challenge.withUnsafeBytes { ch in
                    try scopeSignature.withUnsafeBytes { s in
                        try declarationCodeSignature.withUnsafeBytes { d in
                            try output { out in
                                files.with { c, v, g1, g2 in
                                    idc_session_records_request(
                                        handle, c.bytes, c.count, v.bytes, v.count, g1.bytes, g1.count, g2.bytes, g2.count,
                                        a.bytes, a.count, ch.bytes, ch.count, s.bytes, s.count, d.bytes, d.count, out)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// The four files a proof needs (ADR-0035): the circuit of the
    /// certificate's issuer, its verification key, and the CRS.
    struct ProofFiles {
        let circuit: Data
        let verificationKey: Data
        let crsG1: Data
        let crsG2: Data

        fileprivate func with<T>(_ body: (UnsafeRawBufferPointer, UnsafeRawBufferPointer, UnsafeRawBufferPointer, UnsafeRawBufferPointer) -> T) -> T {
            circuit.withUnsafeBytes { c in
                verificationKey.withUnsafeBytes { v in
                    crsG1.withUnsafeBytes { g1 in
                        crsG2.withUnsafeBytes { g2 in body(c, v, g1, g2) }
                    }
                }
            }
        }
    }

    /// The device's clock as the core takes it: seconds since 1970-01-01T00:00:00Z.
    private static func seconds(_ now: Date) -> Int64 {
        Int64(now.timeIntervalSince1970.rounded(.down))
    }

    /// Runs a function that fills an idc_buf, copies the bytes out and
    /// gives the buffer back to the core. With any code but IDC_OK the
    /// buffer is empty and there is nothing to give back.
    fileprivate static func output(_ call: (UnsafeMutablePointer<idc_buf>) -> Int32) throws -> Data {
        var buf = idc_buf(ptr: nil, len: 0)
        let code = call(&buf)
        guard code == IDC_OK else { throw Failure(code: code) }
        defer { idc_buf_free(&buf) }
        guard let bytes = buf.ptr else { return Data() }
        return Data(bytes: bytes, count: buf.len)
    }
}

private extension UnsafeRawBufferPointer {
    /// The bytes as the C functions take them. An empty `Data` has no
    /// address; the core takes (NULL, 0) for no bytes.
    var bytes: UnsafePointer<UInt8>? {
        bindMemory(to: UInt8.self).baseAddress
    }
}
