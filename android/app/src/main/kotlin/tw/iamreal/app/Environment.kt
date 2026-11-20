package tw.iamreal.app

/**
 * The one environment this app is built for (ADR-0036): the test site and
 * the test roster. It is written here and nowhere else; nothing in the app
 * or from the server changes it.
 */
internal object Environment {
    /** The site the app talks to (ADR-0028). */
    const val SITE = "https://test.iamreal.tw"

    /** Where the public files of that site are. */
    const val DATA = "https://test-data.iamreal.tw"

    /** IDC_ROSTER_TEST of device-core/include/iamreal_device_core.h: the core signs for `iamreal-test:public:0`. */
    const val ROSTER = 1
}
