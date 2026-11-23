import XCTest
@testable import IamrealApp

/// The core, called from Swift the way the app calls it, against
/// spec/vectors/.
final class DeviceCoreTests: XCTestCase {
    func testTheLinkedLibraryIsTheVersionOfTheHeader() throws {
        let header = try Repository.text("device-core/include/iamreal_device_core.h")
        let line = try XCTUnwrap(header.split(separator: "\n").first { $0.hasPrefix("#define IDC_ABI_VERSION ") })
        let version = try XCTUnwrap(UInt32(line.dropFirst("#define IDC_ABI_VERSION ".count)))
        XCTAssertEqual(DeviceCore.linkedABIVersion, version)
        XCTAssertEqual(DeviceCore.headerABIVersion, version)
    }

    func testBarretenbergAnswers() throws {
        XCTAssertNoThrow(try DeviceCore.selfCheck())
    }

    func testTheScopeStringOfEachProofLog() throws {
        let scopes = try XCTUnwrap(try Repository.vectors("scope.json")["scopes"] as? [[String: Any]])
        var seen = 0
        for (name, proofLog) in [("production", DeviceCore.ProofLog.production), ("test", .test)] {
            let accepted = scopes.filter { $0["proof_log"] as? String == name && $0["accepted"] as? Bool == true }
            XCTAssertEqual(accepted.count, 1, name)
            let expected = try XCTUnwrap(accepted.first?["scope_string"] as? String)
            XCTAssertEqual(String(decoding: try DeviceCore.scopeString(proofLog), as: UTF8.self), expected, name)
            seen += 1
        }
        XCTAssertEqual(seen, 2)
    }
}
