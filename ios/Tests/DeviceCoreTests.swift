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

    func testTheScopeStringOfEachRoster() throws {
        let scopes = try XCTUnwrap(try Repository.vectors("scope.json")["scopes"] as? [[String: Any]])
        var seen = 0
        for (name, roster) in [("production", DeviceCore.Roster.production), ("test", .test)] {
            let accepted = scopes.filter { $0["roster"] as? String == name && $0["accepted"] as? Bool == true }
            XCTAssertEqual(accepted.count, 1, name)
            let expected = try XCTUnwrap(accepted.first?["scope_string"] as? String)
            XCTAssertEqual(String(decoding: try DeviceCore.scopeString(roster), as: UTF8.self), expected, name)
            seen += 1
        }
        XCTAssertEqual(seen, 2)
    }

    func testTheDeclarationCodeOfEveryCase() throws {
        let cases = try XCTUnwrap(try Repository.vectors("declaration-code.json")["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        let rosters: [DeviceCore.Roster] = [.production, .test]
        var rostersSeen = Set<Int>()
        for c in cases {
            let label = try XCTUnwrap(c["label"] as? String)
            // The function takes a roster, not a scope string: the cases are in the two open scopes.
            let scope = Data(try XCTUnwrap(c["scope_string"] as? String).utf8)
            let index = try XCTUnwrap(try rosters.firstIndex { try DeviceCore.scopeString($0) == scope }, label)
            rostersSeen.insert(index)
            let accounts = try JSONSerialization.data(withJSONObject: try XCTUnwrap(c["accounts"]))
            let challenge = Data(try XCTUnwrap(c["challenge"] as? String).utf8)
            let code = try DeviceCore.declarationCode(roster: rosters[index], accountsJSON: accounts, challenge: challenge)
            XCTAssertEqual(String(decoding: code, as: UTF8.self), try XCTUnwrap(c["declaration_code"] as? String), label)
        }
        XCTAssertEqual(rostersSeen.count, 2, "cases in both rosters")
    }

    func testAFailureCarriesTheCodeOfTheCore() throws {
        let challenge = Data("2026-11-16.000G40R40M30E209185GR38E1W".utf8)
        let accounts = Data(#"[{"platform":"threads","username":"alice"}]"#.utf8)
        XCTAssertNoThrow(try DeviceCore.declarationCode(roster: .test, accountsJSON: accounts, challenge: challenge))
        for (why, bad) in [("not JSON", Data("threads:alice".utf8)), ("no bytes", Data())] {
            XCTAssertThrowsError(try DeviceCore.declarationCode(roster: .test, accountsJSON: bad, challenge: challenge), why) {
                XCTAssertEqual($0 as? DeviceCore.Failure, .input, why)
            }
        }
        XCTAssertThrowsError(try DeviceCore.declarationCode(roster: .test, accountsJSON: accounts, challenge: Data())) {
            XCTAssertEqual($0 as? DeviceCore.Failure, .input)
        }
    }
}
