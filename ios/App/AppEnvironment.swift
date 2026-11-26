import Foundation

/// Which site the app talks to and which proof log its cards sign for
/// (ADR-0036). Fixed when the app is built, by the compilation condition
/// Config/<environment>.xcconfig sets; nothing in the app, and nothing a
/// server sends, changes it.
enum AppEnvironment {
    #if IAMREAL_ENV_TEST
    /// The test site (ADR-0028).
    static let site = URL(string: "https://test.iamreal.tw")!
    /// Where the test site's public files are.
    static let publicFiles = URL(string: "https://test-data.iamreal.tw")!
    /// The test log: the card signs `iamreal-test:public:0`.
    static let proofLog = DeviceCore.ProofLog.test
    /// The app's page in the App Store, which "到 App Store 更新" opens:
    /// https://apps.apple.com/app/id<the app's number in App Store Connect>.
    /// Not known yet for this build: until it is written here, the screens
    /// about the lowest version say to update without the button.
    static let storePage: URL? = nil
    #else
    #error("No environment: build with one of the files in Config/")
    #endif
}
