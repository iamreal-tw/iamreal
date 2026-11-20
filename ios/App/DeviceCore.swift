import Foundation

/// The C functions of device-core/ (ADR-0034), as Swift: bytes in, bytes
/// out. Every buffer the core hands back is copied into a `Data` and given
/// back to the core, which overwrites it, before the call returns.
///
/// Nothing here takes a PIN, and nothing here keeps state between calls.
/// A call returns when its work is done; one that takes long belongs on a
/// background thread.
///
/// The `Data` a function returns is the caller's, and is not overwritten
/// when it goes away. What the shell reads is public (a scope string); a
/// function added later that returns something to keep off the heap needs
/// a type that is.
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
