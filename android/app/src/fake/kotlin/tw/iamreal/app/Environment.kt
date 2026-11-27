package tw.iamreal.app

/**
 * The environment of the emulator test's build (README.md, "模擬器上過一次卡"): the test log, which its
 * fake card signs for; its server is the test's on this machine (Target.kt), not this site.
 * It is written here and nowhere else; nothing in the app or from the server changes it.
 */
internal object Environment {
    /** The site the app talks to (ADR-0028). */
    const val SITE = TestSite.SITE

    /** Where the public files of that site are. */
    const val DATA = TestSite.DATA

    /** The proof log the core signs for (device-core/include/iamreal_device_core.h, IDC_PROOF_LOG_*). */
    const val PROOF_LOG = TestSite.PROOF_LOG

    /** The production app's page: the emulator test goes through "到 Google Play 更新" as the apps on Google Play have it. */
    val STORE_PAGE: String? = "https://play.google.com/store/apps/details?id=tw.iamreal.app"
}
