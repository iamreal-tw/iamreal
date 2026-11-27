import Foundation

/// What a build of the app is fixed to when it is built; nothing in the
/// app, and nothing a server sends, changes it. Which site the app talks
/// to and which proof log its cards sign for (ADR-0036), by the
/// compilation condition Config/<environment>.xcconfig sets; and which of
/// the three apps of ADR-0040 it is, with the production app's page in
/// the App Store.
enum AppEnvironment {
    #if IAMREAL_ENV_TEST
    /// The test site (ADR-0028).
    static let site = URL(string: "https://test.iamreal.tw")!
    /// Where the test site's public files are.
    static let publicFiles = URL(string: "https://test-data.iamreal.tw")!
    /// The test log: the card signs `iamreal-test:public:0`.
    static let proofLog = DeviceCore.ProofLog.test
    #else
    #error("No environment: build with one of the files in Config/")
    #endif

    /// The three apps of ADR-0040, each a configuration of the project.
    enum App {
        /// tw.iamreal.app (Release): TestFlight, and the App Store from launch.
        case production
        /// tw.iamreal.app.test (TestApp): TestFlight only, never the App Store.
        case test
        /// tw.iamreal.app.dev (Debug): put on a phone by cable, in no store.
        case development
    }

    /// Which app this build is. The project file defines DEBUG in the Debug
    /// configuration only and IAMREAL_TEST_APP in TestApp only.
    static var app: App {
        #if DEBUG
        return .development
        #elseif IAMREAL_TEST_APP
        return .test
        #else
        return .production
        #endif
    }

    /// The number App Store Connect gives the production app,
    /// tw.iamreal.app: digits only, the same whichever site it talks to,
    /// since TestFlight and the App Store are one record there (its
    /// "Apple ID").
    static let storeAppID: String? = "6837606453"

    /// The page "到 App Store 更新" opens; without one, the screens about
    /// the lowest version say to update without the button.
    static let storePage = pageInStore(appID: storeAppID, app: app)

    /// The App Store's page of the app with that number, for the production
    /// app only. None without a number. None for the test app, which is
    /// never in the App Store, nor for the development build, in no store:
    /// the page with that number is the production app's, and updating that
    /// one leaves this build as old as it was.
    static func pageInStore(appID: String?, app: App) -> URL? {
        guard app == .production, let appID, !appID.isEmpty, appID.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        return URL(string: "https://apps.apple.com/app/id\(appID)")
    }
}
