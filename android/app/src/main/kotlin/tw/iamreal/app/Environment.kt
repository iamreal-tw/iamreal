package tw.iamreal.app

/**
 * The environment the app is built for: the test site and the test roster.
 * Both builds have it (ADR-0037): the development build always, the store's
 * build until launch, when one PR gives the store's build the production
 * site and roster of its own. It is written here and nowhere else; nothing
 * in the app or from the server changes it.
 */
internal object Environment {
    /** The site the app talks to (ADR-0028). */
    const val SITE = "https://test.iamreal.tw"

    /** Where the public files of that site are. */
    const val DATA = "https://test-data.iamreal.tw"

    /** IDC_ROSTER_TEST of device-core/include/iamreal_device_core.h: the core signs for `iamreal-test:public:0`. */
    const val ROSTER = 1
}
