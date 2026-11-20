import Foundation
import XCTest

/// The repository this test was built from, read from the Mac's disk: the
/// tests run in the simulator, which sees the files of the Mac. They read
/// spec/vectors/ in place, as the tests of the other implementations do,
/// rather than a copy.
enum Repository {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent()

    static func data(_ path: String) throws -> Data {
        try Data(contentsOf: root.appendingPathComponent(path))
    }

    static func text(_ path: String) throws -> String {
        String(decoding: try data(path), as: UTF8.self)
    }

    /// spec/vectors/<name>, as JSON.
    static func vectors(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: data("spec/vectors/\(name)")) as? [String: Any])
    }

    /// The scope string of the test roster, from spec/vectors/scope.json.
    static func testScopeString() throws -> String {
        let scopes = try XCTUnwrap(try vectors("scope.json")["scopes"] as? [[String: Any]])
        let test = try XCTUnwrap(scopes.first { $0["roster"] as? String == "test" && $0["accepted"] as? Bool == true })
        return try XCTUnwrap(test["scope_string"] as? String)
    }
}
