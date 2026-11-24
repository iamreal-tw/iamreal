import SwiftUI
import UIKit
import XCTest
@testable import IamrealApp

/// The screens of design/screens/ (card-proof-app-*, app-splash), made from
/// the examples of design/copy/card-proof.md (`@alice`, `7K2Q9FM4XD`,
/// 2026-11-16, 王小明) without a back end: every sentence on them is in the
/// document, and each is drawn as the app draws it, the whole screen 390
/// points wide, to web/test-output/app/screens-ios/ under the name of the
/// picture it stands for (ios/README.md, the screenshots).
@MainActor
final class ScreensTests: XCTestCase {
    typealias Flow = CardProofFlow

    private var copy: Copy!
    private var screens: Screens!
    private var document: CopyDocument!

    override func setUpWithError() throws {
        copy = Copy(json: try Repository.data("design/copy/card-proof.json"))
        screens = Screens(copy: copy, host: "iamreal.tw")
        document = try CopyDocument.load()
    }

    /// A card that has declared nothing, on the one platform the app knows.
    private let newCard = Flow.CardStatus(
        shortID: "7K2Q9FM4XD", lastCardProof: nil, daysSince: nil, dailyLimit: false, knownPlatforms: ["threads"],
        rows: [Flow.StatusRow(platform: "threads", known: true, current: nil, lastDeclared: nil, switchCount: 0, switchesLeft: 5, correctionToday: false)])

    private func declaration() -> (Flow.Consequence, Flow.Done) {
        let row = Flow.ConsequenceRow(platform: "threads", known: true, kind: "first", username: "alice", current: nil, previous: nil, switchesLeft: nil)
        let accounts = [Flow.Account(platform: "threads", username: "alice")]
        let consequence = Flow.Consequence(accounts: accounts, rows: [row], firstRecord: true, today: "2026-11-16")
        let done = Flow.Done(
            date: "2026-11-16", shortID: "7K2Q9FM4XD", accounts: accounts, expected: [row],
            answer: Flow.Answer(seq: 138, recordHash: String(repeating: "3f", count: 32), kinds: [Flow.Recorded(platform: "threads", kind: "first", username: "alice", accountCards: 1)], mismatches: []),
            firstRecord: true)
        return (consequence, done)
    }

    /// The screens of a first declaration, by the name of their picture.
    private func firstDeclaration() -> [(String, Screen)] {
        let (consequence, done) = declaration()
        return [
            ("card-proof-app-1-before-phone", screens.before()),
            ("card-proof-app-2-read-phone", screens.read(reached: 0, running: false, stop: nil)),
            ("card-proof-app-3-pin-phone", screens.pin(name: "王小明", state: .waiting(nil))),
            ("card-proof-app-4-accounts-phone", screens.accounts(newCard, typed: ["threads": "alice"], errors: [:], message: nil)),
            ("card-proof-app-5-confirm-phone", screens.confirm(newCard, consequence)),
            ("card-proof-app-5-progress-phone", screens.progress(reached: 2, stop: nil)),
            ("card-proof-app-6-done-phone", screens.done(done, single: "Threads", copied: false)),
        ]
    }

    func testEverySentenceOfTheScreensIsInTheDocument() {
        for (_, screen) in firstDeclaration() {
            document.check(screen)
        }
    }

    /// The splash screen's words are design/copy/app.md's: the lines of the
    /// code block of its section, in their order.
    func testTheSplashScreenSaysWhatAppMDWrites() throws {
        let document = try Repository.text("design/copy/app.md")
        let section = try XCTUnwrap(document.components(separatedBy: "\n## 啟動畫面\n").dropFirst().first)
        let block = try XCTUnwrap(section.components(separatedBy: "```\n").dropFirst().first)
        let appCopy = Copy(json: try Repository.data("design/copy/app.json"))
        XCTAssertEqual(block.split(separator: "\n").map(String.init), [appCopy("splash.name"), appCopy("splash.site")])
    }

    /// No screen links out (docs/design/principles.md, principle 1): what a
    /// button opens is the card's page, the account's, the share sheet.
    func testNoScreenOpensAHelpPage() {
        for (name, screen) in firstDeclaration() {
            XCTAssertFalse(screen.texts.contains("了解更多"), name)
            XCTAssertFalse(screen.texts.contains("怎麼驗證島民證明"), name)
        }
    }

    func testTheScreensAsTheAppDrawsThem() async throws {
        guard #available(iOS 16.4, *) else { throw XCTSkip("pictures are drawn on iOS 16.4 or later") }
        for (name, screen) in firstDeclaration() {
            let view = ScreenView(screen: screen, copy: copy, pinText: .constant(name.contains("-3-") ? "123456" : ""), perform: { _ in }, type: { _, _ in }, unscrolled: true)
            let drawn = await Self.draw(view, height: nil)
            let image = try XCTUnwrap(drawn)
            XCTAssertEqual(image.size.width, 390)
            try Self.save(image, as: name)
        }
        let splashView = SplashView(appCopy: Copy(json: try Repository.data("design/copy/app.json")))
        let drawnSplash = await Self.draw(splashView, height: 844)
        let splash = try XCTUnwrap(drawnSplash)
        try Self.save(splash, as: "app-splash-phone")
    }

    // ---------------------------------------------------------------------------

    /// `view` 390 points wide, as tall as it is (or `height`), one pixel a
    /// point, once the done screen's mark has stood up.
    @available(iOS 16.4, *)
    private static func draw<V: View>(_ view: V, height: CGFloat?) async -> UIImage? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return nil }
        let host = UIHostingController(rootView: view)
        host.safeAreaRegions = []
        let size = CGSize(width: 390, height: height ?? host.sizeThatFits(in: CGSize(width: 390, height: CGFloat.greatestFiniteMagnitude)).height.rounded(.up))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        return image
    }

    private static func save(_ image: UIImage, as name: String) throws {
        let directory = Repository.root.appendingPathComponent("web/test-output/app/screens-ios")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}
