import CryptoKit
import XCTest
@testable import IamrealApp

/// What this build of the app is fixed to (ADR-0036), and what it carries
/// (ADR-0035).
final class BuildTests: XCTestCase {
    func testTheAppIsTheTestApp() throws {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "tw.iamreal.app.test")
        XCTAssertEqual(AppEnvironment.site.absoluteString, "https://test.iamreal.tw")
        XCTAssertEqual(AppEnvironment.publicFiles.absoluteString, "https://test-data.iamreal.tw")
    }

    func testTheCardSignsTheScopeStringOfTheTestRoster() throws {
        let expected = try Repository.testScopeString()
        XCTAssertTrue(expected.hasPrefix("iamreal-test:public:0"))
        XCTAssertEqual(String(decoding: try DeviceCore.scopeString(AppEnvironment.roster), as: UTF8.self), expected)
    }

    func testTheAppRunsOnAniPhoneOnly() throws {
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "UIDeviceFamily") as? [Int], [1])
    }

    /// The circuits and verification keys are the files of this repository.
    func testTheBundledCircuitsAndVerificationKeysAreTheOnesOfTheRepository() throws {
        let sources: [BundledFile: String] = [
            .circuitRS2048: "web/circuits/card_proof_rs2048.json",
            .circuitRS4096: "web/circuits/card_proof_rs4096.json",
            .verificationKeyRS2048: "verifier/vk/card_proof_rs2048.vk",
            .verificationKeyRS4096: "verifier/vk/card_proof_rs4096.vk",
        ]
        for (file, path) in sources {
            XCTAssertEqual(try file.load(), try Repository.data(path), file.rawValue)
        }
    }

    /// The CRS has the SHA-256 of device-core/crs.sha256.
    func testTheBundledCRSHasTheExpectedSHA256() throws {
        var expected: [String: String] = [:]
        for line in try Repository.text("device-core/crs.sha256").split(separator: "\n") {
            let parts = line.components(separatedBy: "  ")
            XCTAssertEqual(parts.count, 2)
            expected[parts[1]] = parts[0]
        }
        for file in [BundledFile.crsG1, .crsG2] {
            let hash = SHA256.hash(data: try file.load()).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(hash, try XCTUnwrap(expected[file.rawValue]), file.rawValue)
        }
        XCTAssertEqual(try BundledFile.crsG1.load().count, 262_144 * 32)
    }

    func testEveryBundledFileIsThere() throws {
        XCTAssertEqual(BundledFile.allCases.count, 6)
        for file in BundledFile.allCases {
            XCTAssertFalse(try file.load().isEmpty, file.rawValue)
        }
    }

    func testTheShellReportsThatTheCoreAnswers() throws {
        let report = CoreReport.make()
        XCTAssertNil(report.selfCheckFailure)
        XCTAssertEqual(report.abiVersion, DeviceCore.headerABIVersion)
        XCTAssertEqual(report.scopeString, try Repository.testScopeString())
    }

    /// The one sentence on the shell's screen is in design/copy/.
    func testTheWordsOnTheScreenAreInDesignCopy() throws {
        let copy = try Repository.text("design/copy/test-site.md")
        XCTAssertTrue(copy.contains("\n\(ScreenCopy.testRoster)\u{3000}"))
    }

    /// The name under the app's icon is what design/copy/ calls the app.
    func testTheNameOfTheAppIsInDesignCopy() throws {
        let name = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        XCTAssertTrue(try Repository.text("design/copy/card-proof.md").contains("「\(name)」app"), name)
    }

    /// The hashes of the CRS are the ones the page's download checks.
    func testTheCRSHashesAreTheOnesOfThePage() throws {
        let page = try Repository.text("web/scripts/fetch-crs.mjs")
        let lines = try Repository.text("device-core/crs.sha256").split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        for line in lines {
            let parts = line.components(separatedBy: "  ")
            XCTAssertTrue(page.contains("name: \"\(parts[1])\""), parts[1])
            XCTAssertTrue(page.contains("sha256: \"\(parts[0])\""), parts[1])
        }
    }
}
