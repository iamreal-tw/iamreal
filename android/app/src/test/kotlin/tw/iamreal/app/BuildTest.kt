package tw.iamreal.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.iamreal.app.core.DeviceCore
import java.io.File

/**
 * What each app is built for (ADR-0040), in the unit tests of its own build type: `iamreal.app` is the
 * identifier of the build type under test and `iamreal.onTestSite` whether it is on the test site
 * (app/build.gradle.kts, onTestSite), so `testReleaseUnitTest` checks the production app, `testTrialUnitTest`
 * the test app, `testDebugUnitTest` the development build.
 */
class BuildTest {
    private val app = System.getProperty("iamreal.app")!!
    private val onTestSite = System.getProperty("iamreal.onTestSite").toBooleanStrict()

    @Test
    fun `the test app and the development build are on the test site for good, and the production app until launch`() {
        if (app == "tw.iamreal.app.test" || app == "tw.iamreal.app.dev") assertTrue("$app is in onTestSite", onTestSite)
        // Launch day: the production app leaves onTestSite, and this line goes with it.
        if (app == "tw.iamreal.app") assertTrue("until launch $app is in onTestSite", onTestSite)
    }

    @Test
    fun `an app on the test site talks to it and signs for the test log`() {
        if (!onTestSite) return
        assertEquals(app, "https://test.iamreal.tw", Environment.SITE)
        assertEquals(app, "https://test-data.iamreal.tw", Environment.DATA)
        val scopes = JSONObject(File(System.getProperty("iamreal.vectors"), "scope.json").readText()).getJSONArray("scopes")
        val test = (0 until scopes.length()).map { scopes.getJSONObject(it) }.single { it.getString("proof_log") == "test" && it.getBoolean("accepted") }
        assertEquals(app, test.getString("scope_string"), String(DeviceCore.scopeString(), Charsets.US_ASCII))
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
