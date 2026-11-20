package tw.iamreal.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

/** The name under the icon against design/copy/: the service's name as the copy writes it, then that this is the test app. */
class AppNameTest {
    @Test
    fun `the app is named after the service, marked as the test app`() {
        val copy = File(System.getProperty("iamreal.copy"), "card-proof.md").readText()
        val service = Regex("下載「(.+?)」app").find(copy)
        assertNotNull("the line of card-proof.md that names the app", service)
        val strings = File(System.getProperty("iamreal.strings")).readText()
        val name = Regex("<string name=\"app_name\">(.*?)</string>").find(strings)!!.groupValues[1]
        assertEquals("${service!!.groupValues[1]} 測試", name)
    }
}
