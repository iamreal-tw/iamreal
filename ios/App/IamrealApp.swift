import SwiftUI
import UIKit

/// The iOS app: the card proof, six screens (CardProofView).
@main
struct IamrealApp: App {
    @StateObject private var model = CardProofModel.ofThisBuild()

    var body: some Scene {
        WindowGroup {
            // Under the tests of Tests/, which run inside the app, the app
            // itself shows nothing and asks the test site for nothing: each
            // test makes its own model, against a back end of its own.
            if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
                CardProofView(model: model)
            }
        }
    }
}

extension CardProofModel {
    /// The card proof of this build: the site and the roster of
    /// AppEnvironment, the core's own session (MOICA's keys), the files
    /// the app carries.
    static func ofThisBuild() -> CardProofModel {
        let flow = CardProofFlow.Dependencies(
            roster: AppEnvironment.roster,
            backend: HTTPBackend(site: AppEnvironment.site, publicFiles: AppEnvironment.publicFiles),
            card: NoCardReader(),
            clock: Date.init,
            crlNumbers: StoredCRLNumbers(),
            openSession: { try DeviceCore.Session(AppEnvironment.roster) },
            proofFiles: BundledFile.proofFiles(for:))
        return CardProofModel(CardProofModel.Dependencies(
            flow: flow,
            copy: Copy.bundled(),
            site: AppEnvironment.site,
            open: { UIApplication.shared.open($0) },
            copyText: { UIPasteboard.general.string = $0 }))
    }
}

/// The words on every screen that are not the card proof's: each as
/// design/copy/ writes it (Tests/BuildTests.swift reads them there).
enum ScreenCopy {
    /// design/copy/test-site.md: the mark of the test roster.
    static let testRoster = "測試名冊"
}
