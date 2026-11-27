package tw.iamreal.app

/**
 * The environment of the production app, tw.iamreal.app (ADR-0040): until launch the test site and the
 * test log, as TestSite has them. On launch day one PR gives this file the production site and proof log;
 * the test app and the development build have files of their own and stay on the test site.
 * It is written here and nowhere else; nothing in the app or from the server changes it.
 */
internal object Environment {
    /** The site the app talks to (ADR-0028). */
    const val SITE = TestSite.SITE

    /** Where the public files of that site are. */
    const val DATA = TestSite.DATA

    /** The proof log the core signs for (device-core/include/iamreal_device_core.h, IDC_PROOF_LOG_*). */
    const val PROOF_LOG = TestSite.PROOF_LOG

    /** Its page on Google Play, which "到 Google Play 更新" opens. */
    val STORE_PAGE: String? = "https://play.google.com/store/apps/details?id=tw.iamreal.app"
}
