package tw.iamreal.app

/**
 * The environment of the test app, tw.iamreal.app.test (ADR-0040): the test site and the test log, always,
 * after launch too. Launch day does not change this file.
 * It is written here and nowhere else; nothing in the app or from the server changes it.
 */
internal object Environment {
    /** The site the app talks to (ADR-0028). */
    const val SITE = TestSite.SITE

    /** Where the public files of that site are. */
    const val DATA = TestSite.DATA

    /** The proof log the core signs for (device-core/include/iamreal_device_core.h, IDC_PROOF_LOG_*). */
    const val PROOF_LOG = TestSite.PROOF_LOG

    /** Its own page on Google Play, which "到 Google Play 更新" opens: whoever installed it from internal testing updates it there. */
    val STORE_PAGE: String? = "https://play.google.com/store/apps/details?id=tw.iamreal.app.test"
}
