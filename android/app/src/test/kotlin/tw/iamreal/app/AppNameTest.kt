package tw.iamreal.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

/** The name under the icon against design/copy/app.md: the two are the same text. */
class AppNameTest {
    @Test
    fun `the name under the icon is the one design copy gives the test app`() {
        val copy = File(System.getProperty("iamreal.copy"), "app.md").readText()
        val section = copy.substringAfter("## 主畫面上的名稱", "")
        val written = Regex("```\n(.+)\n```").find(section)
        assertNotNull("the name in design/copy/app.md", written)
        val strings = File(System.getProperty("iamreal.strings")).readText()
        val name = Regex("<string name=\"app_name\">(.*?)</string>").find(strings)!!.groupValues[1]
        assertEquals(written!!.groupValues[1], name)
    }
}
