import CryptoKit
import XCTest
@testable import IamrealApp

/// What this build of the app is fixed to (ADR-0036, ADR-0037), and what it
/// carries (ADR-0035). The tests run in the Debug configuration: the
/// development build. check-app.sh holds the Release one, the store's
/// build, to its identifier, site and name.
final class BuildTests: XCTestCase {
    func testTheAppIsTheDevelopmentBuildOnTheTestSite() throws {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "tw.iamreal.app.dev")
        XCTAssertEqual(AppEnvironment.site.absoluteString, "https://test.iamreal.tw")
        XCTAssertEqual(AppEnvironment.publicFiles.absoluteString, "https://test-data.iamreal.tw")
    }

    func testTheCardSignsTheScopeStringOfTheTestProofLog() throws {
        let expected = try Repository.testScopeString()
        XCTAssertTrue(expected.hasPrefix("iamreal-test:public:0"))
        XCTAssertEqual(String(decoding: try DeviceCore.scopeString(AppEnvironment.proofLog), as: UTF8.self), expected)
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

    /// The mark of the test log, on every screen, is in design/copy/.
    func testTheWordsOnTheScreenAreInDesignCopy() throws {
        let copy = try Repository.text("design/copy/test-site.md")
        XCTAssertTrue(copy.contains("\n\(ScreenCopy.testProofLog)\u{3000}"))
    }

    /// The name under the app's icon is the one design/copy/app.md gives the development build.
    func testTheNameOfTheAppIsInDesignCopy() throws {
        let name = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        let copy = try Repository.text("design/copy/app.md")
        let names = try XCTUnwrap(copy.components(separatedBy: "\n## 主畫面上的名稱\n").last)
        let section = try XCTUnwrap(names.components(separatedBy: "\n### 開發用 build\n").dropFirst().first)
        XCTAssertEqual(section.components(separatedBy: "```\n").dropFirst().first, "\(name)\n")
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

    /// The sentences the app carries are design/copy/card-proof.json, as it is in the repository.
    func testTheBundledCopyIsTheOneOfTheRepository() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "card-proof", withExtension: "json"))
        XCTAssertEqual(try Data(contentsOf: url), try Repository.data("design/copy/card-proof.json"))
    }

    /// The app's own sentences are design/copy/app.json, as it is in the repository.
    func testTheBundledAppCopyIsTheOneOfTheRepository() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "app", withExtension: "json"))
        XCTAssertEqual(try Data(contentsOf: url), try Repository.data("design/copy/app.json"))
    }

    /// The headings' typeface is the subset of design/fonts/, as it is in the repository.
    func testTheBundledTypefaceIsTheOneOfTheRepository() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "GenRyuMin2TW-B", withExtension: "otf"))
        XCTAssertEqual(try Data(contentsOf: url), try Repository.data("design/fonts/GenRyuMin2TW-B.otf"))
    }

    /// Every sentence the sources name is in that file (`copy("…")`), or
    /// for what is not the card proof's in design/copy/app.json
    /// (`appCopy("…")`), and the sources write none of their own: no
    /// character of Chinese outside the mark of the test log.
    func testTheSourcesTakeEverySentenceFromTheCopy() throws {
        let files = [
            "copy": ("design/copy/card-proof.json", Copy(json: try Repository.data("design/copy/card-proof.json"))),
            "appCopy": ("design/copy/app.json", Copy(json: try Repository.data("design/copy/app.json"))),
        ]
        let key = try NSRegularExpression(pattern: #"\b(copy|appCopy)\("([a-z_]+\.[a-z_]+)""#)
        var keys: [String: Int] = [:]
        for (name, source) in try appSources() {
            for match in key.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                let call = String(source[try XCTUnwrap(Range(match.range(at: 1), in: source))])
                let named = String(source[try XCTUnwrap(Range(match.range(at: 2), in: source))])
                let (path, copy) = try XCTUnwrap(files[call])
                XCTAssertNotEqual(copy(named), named, "\(name) names \(named), which \(path) does not have")
                keys[call, default: 0] += 1
            }
            for line in source.split(separator: "\n") where !line.contains("static let testProofLog") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                XCTAssertNil(line.unicodeScalars.first { (0x2E80...0x9FFF).contains($0.value) || (0xFF00...0xFFEF).contains($0.value) }, "\(name): \(line)")
            }
        }
        XCTAssertGreaterThan(keys["copy", default: 0], 100)
        XCTAssertEqual(keys["appCopy"], 2, "the splash screen's two")
    }

    /// The PIN and a card proof under way are in memory only: the sources
    /// use nothing that writes a file, nothing the system saves and
    /// restores a scene with, and no content type on a field, by which the
    /// system would offer to save what is typed. The one thing kept is the highest CRL number
    /// of each issuer, in App/CRLNumbers.swift.
    func testNothingOfACardProofIsWrittenToDisk() throws {
        let forbidden = try NSRegularExpression(pattern: #"SceneStorage|AppStorage|NSUserActivity|restorationIdentifier|encodeRestorableState|UserDefaults|FileManager|NSKeyedArchiver|\.write\(|Keychain|SecItem|NSUbiquitous|CoreData|UIPasteboard|textContentType"#)
        var allowed = 0
        for (name, source) in try appSources() {
            for match in forbidden.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                let word = String(source[try XCTUnwrap(Range(match.range, in: source))])
                // The CRL numbers, and the link the cardholder asks to copy.
                if (name == "CRLNumbers.swift" && word == "UserDefaults") || (name == "IamrealApp.swift" && word == "UIPasteboard") {
                    allowed += 1
                    continue
                }
                XCTFail("\(name) uses \(word)")
            }
        }
        XCTAssertGreaterThan(allowed, 0)
    }

    /// The Swift sources of the app, by file name.
    private func appSources() throws -> [(String, String)] {
        let directory = Repository.root.appendingPathComponent("ios/App")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertGreaterThan(names.count, 8)
        return try names.map { ($0, try Repository.text("ios/App/\($0)")) }
    }
}
