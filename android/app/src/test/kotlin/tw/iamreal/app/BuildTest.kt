package tw.iamreal.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What each app is built for (ADR-0040), in the unit tests of its own build type: `iamreal.app` is the
 * identifier of the build type under test (app/build.gradle.kts), so `testReleaseUnitTest` checks the
 * production app, `testTrialUnitTest` the test app, `testDebugUnitTest` the development build. The proof log
 * each signs for is DeviceCoreTest's "the scope string is the one of the test log", which runs in each.
 */
class BuildTest {
    private val app = System.getProperty("iamreal.app")!!

    @Test
    fun `every app talks to the test site until launch, and the test app and the development build always`() {
        assertEquals(app, "https://test.iamreal.tw", Environment.SITE)
        assertEquals(app, "https://test-data.iamreal.tw", Environment.DATA)
    }

    @Test
    fun `the update button opens the app's own page on Google Play, and the development build has none`() {
        when (app) {
            "tw.iamreal.app", "tw.iamreal.app.test" -> assertEquals("https://play.google.com/store/apps/details?id=$app", Environment.STORE_PAGE)
            "tw.iamreal.app.dev" -> assertNull(Environment.STORE_PAGE)
            else -> throw AssertionError("no unit tests for $app")
        }
    }
}
