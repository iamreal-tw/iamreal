package tw.iamreal.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The app's Kotlin sources take every sentence from design/copy/card-proof.json and app.json: each key
 * they name (`say("group.key"`, `has("group.key"`) is in one of them, and outside comments they write no character of
 * Chinese of their own. So a sentence taken out of the copy cannot stay on a screen. The same check as
 * ios/Tests/BuildTests.swift and web/test/copy.test.ts.
 */
class SourcesCopyTest {
    private val copy = File(System.getProperty("iamreal.copy"))
    private val sources = copy.resolve("../../android/app/src/main/kotlin").normalize()

    private fun files(): List<File> = sources.walk().filter { it.isFile && it.extension == "kt" }.toList()

    @Test
    fun `every key the sources name is in card-proof json or app json`() {
        val files = listOf(JSONObject(File(copy, "card-proof.json").readText()), JSONObject(File(copy, "app.json").readText()))
        val key = Regex("""\b(?:say|has)\("([a-z_]+)\.([a-z_]+)"""")
        var named = 0
        for (file in files()) {
            for (match in key.findAll(file.readText())) {
                val (group, name) = match.destructured
                assertTrue("${file.name} names $group.$name, which neither design/copy/card-proof.json nor app.json has", files.any { it.optJSONObject(group)?.has(name) == true })
                named++
            }
        }
        assertTrue("the check found the sources' keys ($named)", named > 100)
    }

    @Test
    fun `the sources write no sentence of their own`() {
        val chinese = Regex("[\\u2E80-\\u9FFF\\uFF00-\\uFFEF]")
        val found = files().flatMap { file ->
            file.readLines().withIndex()
                .filter { (_, line) -> chinese.containsMatchIn(line.substringBefore("//")) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*") }
                .map { (at, line) -> "${file.name}:${at + 1}: ${line.trim()}" }
        }
        assertEquals("lines of the sources with words of their own", emptyList<String>(), found)
        assertTrue(files().size > 10)
    }
}
