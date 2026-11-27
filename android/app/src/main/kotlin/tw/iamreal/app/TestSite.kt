package tw.iamreal.app

/**
 * The test site and the test log (ADR-0028, ADR-0040): what the test app and the development build always
 * talk to and sign for, and the production app until launch. Each build type's Environment.kt says which
 * site its app has; this is the one place the test site's are written.
 */
internal object TestSite {
    /** The site (ADR-0028). */
    const val SITE = "https://test.iamreal.tw"

    /** Where the public files of that site are. */
    const val DATA = "https://test-data.iamreal.tw"

    /** IDC_PROOF_LOG_TEST of device-core/include/iamreal_device_core.h: the core signs for `iamreal-test:public:0`. */
    const val PROOF_LOG = 1
}
