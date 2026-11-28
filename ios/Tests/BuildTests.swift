import CryptoKit
import XCTest
@testable import IamrealApp

/// What this build of the app is fixed to (ADR-0036, ADR-0040), and what it
/// carries (ADR-0035). The tests run in the Debug configuration: the
/// development build. check-app.sh holds the other two, Release (the
/// production app) and TestApp (the test app), to their identifier, site
/// and name.
final class BuildTests: XCTestCase {
    func testTheAppIsTheDevelopmentBuildOnTheTestSite() throws {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "tw.iamreal.app.dev")
        XCTAssertEqual(AppEnvironment.site.absoluteString, "https://test.iamreal.tw")
        XCTAssertEqual(AppEnvironment.publicFiles.absoluteString, "https://test-data.iamreal.tw")
    }

    /// Only the production app opens a page in the App Store (#484): the test app is never there, and the development build is in no store.
    func testOnlyTheProductionAppOpensItsPageInTheStore() throws {
        XCTAssertEqual(AppEnvironment.pageInStore(appID: "1234567890", app: .production)?.absoluteString, "https://apps.apple.com/app/id1234567890")
        // The page with the production app's number would be of another app.
        XCTAssertNil(AppEnvironment.pageInStore(appID: "1234567890", app: .test))
        XCTAssertNil(AppEnvironment.pageInStore(appID: "1234567890", app: .development))
        // No number, or not a number: no page, so no button.
        XCTAssertNil(AppEnvironment.pageInStore(appID: nil, app: .production))
        XCTAssertNil(AppEnvironment.pageInStore(appID: "", app: .production))
        XCTAssertNil(AppEnvironment.pageInStore(appID: "id1234567890", app: .production))
        // The number the maintainer was given for tw.iamreal.app.
        XCTAssertEqual(AppEnvironment.pageInStore(appID: AppEnvironment.storeAppID, app: .production)?.absoluteString, "https://apps.apple.com/app/id6837606453")
        // This build, the development one.
        XCTAssertEqual(AppEnvironment.app, .development)
        XCTAssertNil(AppEnvironment.storePage)
    }

    func testTheCardSignsTheScopeStringOfTheTestProofLog() throws {
        let expected = try Repository.testScopeString()
        XCTAssertTrue(expected.hasPrefix("iamreal-test:public:0"))
        XCTAssertEqual(String(decoding: try DeviceCore.scopeString(AppEnvironment.proofLog), as: UTF8.self), expected)
    }

    /// The test app signs the test log's scope string, as the build tested
    /// here does (the test above), and keeps doing so after launch (#484):
    /// its configuration, TestApp, is based on Config/Test.xcconfig, whose
    /// environment is the test one, and compiles with that environment and
    /// no DEBUG. check-app.sh sees the same in the app TestApp builds: the
    /// test site's addresses and not the production site's.
    func testTheTestAppIsBuiltForTheTestEnvironment() throws {
        let project = try Repository.text("ios/IamrealApp.xcodeproj/project.pbxproj")
        let configurations = project.components(separatedBy: " /* TestApp */ = {").dropFirst().map { $0.components(separatedBy: "\n\t\t};").first ?? "" }
        // One for the project, one for the app, one for the tests.
        XCTAssertEqual(configurations.count, 3)
        let projectLevel = try XCTUnwrap(configurations.first { $0.contains("SWIFT_ACTIVE_COMPILATION_CONDITIONS") })
        XCTAssertTrue(projectLevel.contains("baseConfigurationReference = 1A0000000000000000000004 /* Test.xcconfig */;"))
        // The environment's condition and the test app's, and not DEBUG.
        XCTAssertTrue(projectLevel.contains("SWIFT_ACTIVE_COMPILATION_CONDITIONS = \"$(IAMREAL_ENVIRONMENT) IAMREAL_TEST_APP\";"))
        let environment = try Repository.text("ios/Config/Test.xcconfig")
        XCTAssertTrue(environment.contains("\nIAMREAL_ENVIRONMENT = IAMREAL_ENV_TEST\n"))
        // And for every configuration: none is given another environment by a condition.
        XCTAssertFalse(environment.contains("IAMREAL_ENVIRONMENT["))
        XCTAssertTrue(environment.contains("\nIAMREAL_BUNDLE_IDENTIFIER[config=TestApp] = tw.iamreal.app.test\n"))
        // No configuration sets an environment of its own.
        XCTAssertFalse(configurations.contains { $0.contains("IAMREAL_ENVIRONMENT =") })
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

    /// Reading the card over NFC: the purpose iOS asks for is
    /// design/copy/app.md's; the applications the app may select by name
    /// are the three it selects (spec/card-channel.md), the one that signs first, so
    /// that the system selects it before it hands the card over; and the
    /// app is offered only to a device that can read NFC.
    func testTheAppDeclaresReadingTheCard() throws {
        let app = try XCTUnwrap(try JSONSerialization.jsonObject(with: Repository.data("design/copy/app.json")) as? [String: [String: String]])
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "NFCReaderUsageDescription") as? String, app["nfc"]?["usage"])
        let identifiers = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "com.apple.developer.nfc.readersession.iso7816.select-identifiers") as? [String])
        let named = [CardChannel.GPPKI_AID, CardChannel.ISD_CM_AID, CardChannel.ISD_AID].map { $0.map { String(format: "%02X", $0) }.joined() }
        XCTAssertEqual(identifiers, named)
        XCTAssertTrue((Bundle.main.object(forInfoDictionaryKey: "UIRequiredDeviceCapabilities") as? [String] ?? []).contains("nfc"))
    }

    /// The answer to App Store Connect's export compliance question, given
    /// once in Info.plist so that no build waits on it (README.md, "上傳之後營運者做的").
    func testTheAppSaysItUsesOnlyExemptEncryption() {
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "ITSAppUsesNonExemptEncryption") as? Bool, false)
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

    /// The timeline of step 6's demonstration is design/motion/hang.json, as it is in the repository: the app has no
    /// copy of its own, and what it reads is what the site and the Android app read.
    func testTheBundledTimelineIsTheOneOfTheRepository() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "hang", withExtension: "json"))
        XCTAssertEqual(try Data(contentsOf: url), try Repository.data("design/motion/hang.json"))
        let bundled = try XCTUnwrap(HangTimeline.bundled)
        XCTAssertEqual(bundled, try JSONDecoder().decode(HangTimeline.self, from: Repository.data("design/motion/hang.json")))
        XCTAssertEqual(bundled.duration, 20.7)
    }

    /// The timeline of step 2's demonstration is design/motion/sense.json, as it is in the repository.
    func testTheBundledTimelineOfTheCardsPlaceIsTheOneOfTheRepository() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "sense", withExtension: "json"))
        XCTAssertEqual(try Data(contentsOf: url), try Repository.data("design/motion/sense.json"))
        XCTAssertEqual(try XCTUnwrap(SenseTimeline.bundled), try JSONDecoder().decode(SenseTimeline.self, from: Repository.data("design/motion/sense.json")))
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
        let key = try NSRegularExpression(pattern: #"\b(copy|appCopy)\("([a-z_]+\.[a-z_0-9]+)""#)
        var keys: [String: Int] = [:]
        var appKeys: Set<String> = []
        for (name, source) in try appSources() {
            for match in key.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                let call = String(source[try XCTUnwrap(Range(match.range(at: 1), in: source))])
                let named = String(source[try XCTUnwrap(Range(match.range(at: 2), in: source))])
                let (path, copy) = try XCTUnwrap(files[call])
                XCTAssertNotEqual(copy(named), named, "\(name) names \(named), which \(path) does not have")
                keys[call, default: 0] += 1
                if call == "appCopy" { appKeys.insert(named) }
            }
            for line in source.split(separator: "\n") where !line.contains("static let testProofLog") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                XCTAssertNil(line.unicodeScalars.first { (0x2E80...0x9FFF).contains($0.value) || (0xFF00...0xFFEF).contains($0.value) }, "\(name): \(line)")
            }
        }
        XCTAssertGreaterThan(keys["copy", default: 0], 100)
        // Every sentence of app.json but the names under the icon, which
        // the project file holds, Android's category of notifications, and
        // the purpose of reading NFC, which Config/Info.plist holds.
        let app = try XCTUnwrap(try JSONSerialization.jsonObject(with: Repository.data("design/copy/app.json")) as? [String: [String: String]])
        let all = Set(app.flatMap { group, entries in entries.keys.map { "\(group).\($0)" } })
        XCTAssertEqual(appKeys, all.subtracting(["name.production", "name.test", "name.dev", "notification.channel", "nfc.usage"]))
    }

    /// The PIN and a card proof under way are in memory only: the sources
    /// use nothing that writes a file, nothing the system saves and
    /// restores a scene with, and no content type on a field, by which the
    /// system would offer to save what is typed. What is kept: the highest
    /// CRL number of each issuer, in App/CRLNumbers.swift, and the four
    /// settings of the reminder, in App/Reminder.swift (ADR-0016), and the
    /// card proof device ID, in App/Counts.swift (ADR-0039).
    func testNothingOfACardProofIsWrittenToDisk() throws {
        let forbidden = try NSRegularExpression(pattern: #"SceneStorage|AppStorage|NSUserActivity|restorationIdentifier|encodeRestorableState|UserDefaults|FileManager|NSKeyedArchiver|\.write\(|Keychain|SecItem|NSUbiquitous|CoreData|UIPasteboard|textContentType"#)
        var allowed = 0
        for (name, source) in try appSources() {
            for match in forbidden.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                let word = String(source[try XCTUnwrap(Range(match.range, in: source))])
                // The CRL numbers, and the link the cardholder asks to copy.
                if (["CRLNumbers.swift", "Reminder.swift", "Counts.swift"].contains(name) && word == "UserDefaults") || (name == "IamrealApp.swift" && word == "UIPasteboard") {
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
