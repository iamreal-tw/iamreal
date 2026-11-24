import SwiftUI
import UIKit

/// The iOS app: the splash screen (SplashView), then the card proof, six
/// screens (CardProofView).
@main
struct IamrealApp: App {
    @StateObject private var model = CardProofModel.ofThisBuild()
    @State private var opening = true

    var body: some Scene {
        WindowGroup {
            // Under the tests of Tests/, which run inside the app, the app
            // itself shows nothing and asks the test site for nothing: each
            // test makes its own model, against a back end of its own.
            if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
                Group {
                    if opening {
                        SplashView(appCopy: Copy.bundled("app"))
                    } else {
                        CardProofView(model: model)
                    }
                }
                // The colors are design/tokens.json's, whatever the phone's appearance.
                .preferredColorScheme(.light)
                .task {
                    // The server is asked for its config while the splash screen is up.
                    model.open()
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    withAnimation(.easeOut(duration: 0.2)) { opening = false }
                }
            }
        }
    }
}

extension CardProofModel {
    /// The card proof of this build: the site and the proof log of
    /// AppEnvironment, the core's own session (MOICA's keys), the files
    /// the app carries.
    static func ofThisBuild() -> CardProofModel {
        let flow = CardProofFlow.Dependencies(
            proofLog: AppEnvironment.proofLog,
            backend: HTTPBackend(site: AppEnvironment.site, publicFiles: AppEnvironment.publicFiles),
            card: NoCardReader(),
            clock: Date.init,
            crlNumbers: StoredCRLNumbers(),
            openSession: { try DeviceCore.Session(AppEnvironment.proofLog) },
            proofFiles: BundledFile.proofFiles(for:))
        return CardProofModel(CardProofModel.Dependencies(
            flow: flow,
            copy: Copy.bundled(),
            site: AppEnvironment.site,
            open: { UIApplication.shared.open($0) },
            copyText: { UIPasteboard.general.string = $0 },
            share: share))
    }

    /// The system's share sheet with `address`, over what the app shows.
    private static func share(_ address: URL) {
        let sheet = UIActivityViewController(activityItems: [address], applicationActivities: nil)
        var top = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        top?.present(sheet, animated: true)
    }
}

/// The words on every screen that are not the card proof's: each as
/// design/copy/ writes it (Tests/BuildTests.swift reads them there).
enum ScreenCopy {
    /// design/copy/test-site.md: the mark of the test log.
    static let testProofLog = "測試的證明紀錄"
}
