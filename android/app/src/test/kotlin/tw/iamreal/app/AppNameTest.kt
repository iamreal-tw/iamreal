package tw.iamreal.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

/**
 * The name under the icon of each build (ADR-0037) against design/copy/app.md: the two are the same text.
 * And app.json gives each build's name under that build's key (AppCopyTest checks the two files hold the same lines).
 */
class AppNameTest {
    @Test
    fun `the name under the icon of the store's build is the one design copy gives it`() {
        assertEquals(written("商店的 build"), nameIn("iamreal.strings.store"))
    }

    @Test
    fun `the name under the icon of the development build is the one design copy gives it`() {
        assertEquals(written("開發用 build"), nameIn("iamreal.strings.dev"))
    }

    @Test
    fun `app json gives each build the name app md gives it`() {
        val names = JSONObject(File(System.getProperty("iamreal.copy"), "app.json").readText()).getJSONObject("name")
        assertEquals(written("商店的 build"), names.getString("store"))
        assertEquals(written("開發用 build"), names.getString("dev"))
    }

    @Test
    fun `the two builds have different names`() {
        assertNotEquals(nameIn("iamreal.strings.store"), nameIn("iamreal.strings.dev"))
    }

    /** The first code block under `### <build>` in "## 主畫面上的名稱" of design/copy/app.md. */
    private fun written(build: String): String {
        val copy = File(System.getProperty("iamreal.copy"), "app.md").readText()
        val section = copy.substringAfter("\n## 主畫面上的名稱\n", "").substringAfter("\n### $build\n", "").substringBefore("\n#")
        val block = Regex("```\n(.+)\n```").find(section)
        assertNotNull("the name of $build in design/copy/app.md", block)
        return block!!.groupValues[1]
    }

    /** `app_name` in the strings file the system property names. */
    private fun nameIn(property: String): String {
        val strings = File(System.getProperty(property)).readText()
        return Regex("<string name=\"app_name\">(.*?)</string>").find(strings)!!.groupValues[1]
    }
}
