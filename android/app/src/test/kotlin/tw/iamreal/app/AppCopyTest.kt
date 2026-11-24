package tw.iamreal.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * design/copy/app.json is design/copy/app.md in the form a program reads, both ways: every value of
 * the JSON is a line of one of the Markdown's code blocks, word for word, and every line of those
 * blocks is a value of the JSON. The two apps carry app.json (app/build.gradle.kts, ios/).
 */
class AppCopyTest {
    private val dir = File(System.getProperty("iamreal.copy"))

    @Test
    fun `every value of app json is a line of a code block of app md`() {
        val lines = blockLines()
        for ((key, value) in values()) assertTrue("$key: \"$value\" is not a line of a code block of design/copy/app.md", value in lines)
    }

    @Test
    fun `every line of a code block of app md is a value of app json`() {
        val values = values().values.toSet()
        for (line in blockLines()) assertTrue("\"$line\" of design/copy/app.md is no value of design/copy/app.json", line in values)
    }

    @Test
    fun `the check read both files`() {
        assertEquals("島民證明 dev", values()["name.dev"])
        assertTrue(blockLines().size >= 2)
    }

    /** Every string of app.json, by its path of keys (`name.store`). */
    private fun values(): Map<String, String> {
        val out = linkedMapOf<String, String>()
        fun walk(prefix: String, o: JSONObject) {
            for (k in o.keys()) {
                when (val v = o.get(k)) {
                    is JSONObject -> walk("$prefix$k.", v)
                    is String -> out["$prefix$k"] = v
                    else -> throw AssertionError("$prefix$k in design/copy/app.json is neither a group nor a string")
                }
            }
        }
        walk("", JSONObject(File(dir, "app.json").readText()))
        return out
    }

    /** The non-empty lines of the code blocks of app.md. */
    private fun blockLines(): List<String> =
        Regex("(?m)^```\\n([\\s\\S]*?)^```$").findAll(File(dir, "app.md").readText())
            .flatMap { it.groupValues[1].lines() }
            .filter { it.isNotBlank() }
            .toList()
}
