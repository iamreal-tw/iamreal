import Foundation

/// The C functions of device-core/ (ADR-0034), as Swift: bytes in, bytes
/// out. Every buffer the core hands back is copied into a `Data` and given
/// back to the core, which overwrites it, before the call returns.
///
/// Nothing here takes a PIN, and nothing here keeps state between calls.
/// A call returns when its work is done; one that takes long belongs on a
/// background thread.
enum DeviceCore {
    /// Which roster: the app is built for one (AppEnvironment).
    enum Roster {
        case production
        case test

        fileprivate var number: UInt32 {
            switch self {
            case .production: return UInt32(IDC_ROSTER_PRODUCTION)
            case .test: return UInt32(IDC_ROSTER_TEST)
            }
        }
    }

    /// A call that did not return IDC_OK. It carries the code and nothing
    /// read from a card, a certificate, a revocation list or an account.
    struct Failure: Error, Equatable {
        let code: Int32

        /// The call itself is wrong: a mistake in the app's code.
        static let argument = Failure(code: IDC_ERR_ARGUMENT)
        /// The bytes passed in are not what the function reads.
        static let input = Failure(code: IDC_ERR_INPUT)
        /// The core failed: a panic, or Barretenberg did not answer.
        static let `internal` = Failure(code: IDC_ERR_INTERNAL)
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

    /// The scope string a card signs for `roster`: 31 bytes.
    static func scopeString(_ roster: Roster) throws -> Data {
        try output { idc_scope_string(roster.number, $0) }
    }

    /// The declaration code of a list of accounts and a challenge in the
    /// scope of `roster`: 31 bytes, the second message the card signs.
    /// `accountsJSON` is the record's `accounts`; `challenge` is the
    /// challenge as the server issued it.
    static func declarationCode(roster: Roster, accountsJSON: Data, challenge: Data) throws -> Data {
        try accountsJSON.withUnsafeBytes { accounts in
            try challenge.withUnsafeBytes { challenge in
                try output {
                    idc_declaration_code(
                        roster.number,
                        accounts.bindMemory(to: UInt8.self).baseAddress, accounts.count,
                        challenge.bindMemory(to: UInt8.self).baseAddress, challenge.count,
                        $0)
                }
            }
        }
    }

    /// Runs a function that fills an idc_buf, copies the bytes out and
    /// gives the buffer back to the core. With any code but IDC_OK the
    /// buffer is empty and there is nothing to give back.
    private static func output(_ call: (UnsafeMutablePointer<idc_buf>) -> Int32) throws -> Data {
        var buf = idc_buf(ptr: nil, len: 0)
        let code = call(&buf)
        guard code == IDC_OK else { throw Failure(code: code) }
        defer { idc_buf_free(&buf) }
        guard let bytes = buf.ptr else { return Data() }
        return Data(bytes: bytes, count: buf.len)
    }
}
