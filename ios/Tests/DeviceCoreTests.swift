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

    /// The lowest app version, as the app reads it through the core
    /// (MinApp.read, idc_min_app), against the cases of
    /// spec/vectors/min-app.json for the iOS app: new enough, older before
    /// the day and from it, and every field that cannot be read.
    func testTheLowestVersionIsWhatTheVectorsSayForTheIOSApp() throws {
        let cases = try XCTUnwrap(try Repository.vectors("min-app.json")["cases"] as? [[String: Any]])
        var verdicts: Set<String> = []
        for item in cases where item["client"] as? String == "ios" {
            let name = try XCTUnwrap(item["name"] as? String)
            let config = try JSONSerialization.data(withJSONObject: try XCTUnwrap(item["config"]), options: [.fragmentsAllowed])
            let build = try XCTUnwrap(item["app_build"] as? Int)
            let now = Date(timeIntervalSince1970: TimeInterval(try XCTUnwrap(item["now"] as? Int)))
            let result = try XCTUnwrap(item["result"] as? String)
            verdicts.insert(result)
            let read = MinApp.read(config: config, build: String(build), now: now)
            switch result {
            case "ok": XCTAssertEqual(read, .ok, name)
            case "ok_until": XCTAssertEqual(read, .okUntil(try XCTUnwrap(item["from"] as? String)), name)
            case "stop":
                // The day it started on, which the screen writes: the config's own.
                guard case .stop(let from) = read else { XCTFail("\(name): \(read)"); continue }
                XCTAssertEqual(from.count, 10, name)
            case "unreadable": XCTAssertEqual(read, .unreadable, name)
            default: XCTFail("\(name): a verdict the test does not know, \(result)")
            }
        }
        XCTAssertEqual(verdicts, ["ok", "ok_until", "stop", "unreadable"], "the cases cover every verdict for the iOS app")
        // A build number that is not one: the app does not go on.
        XCTAssertEqual(MinApp.read(config: Data("{}".utf8), build: nil, now: Date()), .unreadable)
        XCTAssertEqual(MinApp.read(config: Data("{}".utf8), build: "1.2", now: Date()), .unreadable)
    }
}
