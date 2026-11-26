import Foundation

/// What a build of the app is fixed to when it is built; nothing in the
/// app, and nothing a server sends, changes it. Which site the app talks
/// to and which proof log its cards sign for (ADR-0036), by the
/// compilation condition Config/<environment>.xcconfig sets; and which of
/// the two builds it is, the store's or the development one (ADR-0037),
/// with the store's page of the one app there.
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

    /// The number App Store Connect gives the one app in the store,
    /// tw.iamreal.app (ADR-0037): digits only, the same whichever site
    /// the store's build talks to, since TestFlight and the App Store are
    /// one record there (its "Apple ID").
    static let storeAppID: String? = "6837606453"

    /// Whether this is the store's build (Release) and not the development
    /// build (Debug, tw.iamreal.app.dev), which is not in the store. The
    /// project file defines DEBUG in the Debug configuration only.
    static var storeBuild: Bool {
        #if DEBUG
        return false
        #else
        return true
        #endif
    }

    /// The page "到 App Store 更新" opens; without one, the screens about
    /// the lowest version say to update without the button.
    static let storePage = pageInStore(appID: storeAppID, storeBuild: storeBuild)

    /// The store's page of the app with that number. None without
    /// a number, and none in the development build: the store's
    /// page is of another app, and updating that one leaves this build as
    /// old as it was.
    static func pageInStore(appID: String?, storeBuild: Bool) -> URL? {
        guard storeBuild, let appID, !appID.isEmpty, appID.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        return URL(string: "https://apps.apple.com/app/id\(appID)")
    }
}
