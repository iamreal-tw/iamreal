package tw.iamreal.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

/**
 * The name under the icon of each app (ADR-0040) against design/copy/app.md: the two are the same text.
 * And app.json gives each app's name under that app's key (AppCopyTest checks the two files hold the same lines).
 */
class AppNameTest {
    @Test
    fun `the name under the icon of the production app is the one design copy gives it`() {
        assertEquals(written("正式 app"), nameIn("iamreal.strings.production"))
    }

    @Test
    fun `the name under the icon of the test app is the one design copy gives it`() {
        assertEquals(written("測試 app"), nameIn("iamreal.strings.test"))
    }

    @Test
    fun `the name under the icon of the development build is the one design copy gives it`() {
        assertEquals(written("開發用 build"), nameIn("iamreal.strings.dev"))
    }

    @Test
    fun `app json gives each app the name app md gives it`() {
        val names = JSONObject(File(System.getProperty("iamreal.copy"), "app.json").readText()).getJSONObject("name")
        assertEquals(written("正式 app"), names.getString("production"))
        assertEquals(written("測試 app"), names.getString("test"))
        assertEquals(written("開發用 build"), names.getString("dev"))
        assertEquals(setOf("production", "test", "dev"), names.keys().asSequence().toSet())
    }

    @Test
    fun `the three apps have different names`() {
        val names = listOf(written("正式 app"), written("測試 app"), written("開發用 build"))
        assertEquals(names.size, names.toSet().size)
    }

    /** The first code block under `### <app>` in "## 主畫面上的名稱" of design/copy/app.md. */
    private fun written(app: String): String {
        val copy = File(System.getProperty("iamreal.copy"), "app.md").readText()
        val section = copy.substringAfter("\n## 主畫面上的名稱\n", "").substringAfter("\n### $app\n", "").substringBefore("\n#")
        val block = Regex("```\n(.+)\n```").find(section)
        assertNotNull("the name of $app in design/copy/app.md", block)
        return block!!.groupValues[1]
    }

    /** `app_name` in the strings file the system property names. */
    private fun nameIn(property: String): String {
        val strings = File(System.getProperty(property)).readText()
        return Regex("<string name=\"app_name\">(.*?)</string>").find(strings)!!.groupValues[1]
    }
}
