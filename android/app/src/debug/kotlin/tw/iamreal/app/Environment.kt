package tw.iamreal.app

/**
 * The environment of the development build, tw.iamreal.app.dev (ADR-0040): the test site and the test log,
 * always.
 * It is written here and nowhere else; nothing in the app or from the server changes it.
 */
internal object Environment {
    /** The site the app talks to (ADR-0028). */
    const val SITE = TestSite.SITE

    /** Where the public files of that site are. */
    const val DATA = TestSite.DATA

    /** The proof log the core signs for (device-core/include/iamreal_device_core.h, IDC_PROOF_LOG_*). */
    const val PROOF_LOG = TestSite.PROOF_LOG

    /** None: the development build is not on Google Play, so it has no "到 Google Play 更新" (as on iOS). */
    val STORE_PAGE: String? = null
}
