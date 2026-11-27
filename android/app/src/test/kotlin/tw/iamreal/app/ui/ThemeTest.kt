package tw.iamreal.app.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The theme's values are design/tokens.json's (design/DESIGN.md, "數值怎麼用"):
 * each token the screens use, written in Theme.kt as tokens.json writes it,
 * is the value of the same name there. The file is read where it is: next to
 * design/copy/, which the build hands the tests (app/build.gradle.kts).
 */
class ThemeTest {
    private val tokens = JSONObject(File(File(System.getProperty("iamreal.copy")).parentFile, "tokens.json").readText())

    @Test
    fun `every value of the theme is the token of the same name in tokens json`() {
        for ((name, value) in Tokens.css) {
            assertTrue("$name is no token of design/tokens.json", tokens.has(name))
            assertEquals("$name in Theme.kt", tokens.getString(name), value)
        }
    }

    @Test
    fun `the theme has the colours and the phone's sizes of the screens`() {
        // Not an empty theme passing the test above: the ones every screen draws with.
        for (name in listOf("--bg", "--ink", "--text", "--mute", "--line", "--soft", "--you", "--size-h2-phone", "--size-body-phone", "--button-height", "--gutter-phone")) {
            assertTrue("Theme.kt has no $name", name in Tokens.css)
        }
    }

    @Test
    fun `the colours of the window and the system's splash are the tokens of the same name`() {
        // res/values/colors.xml, next to the strings the build hands the tests.
        val colours = File(File(System.getProperty("iamreal.strings.production")).parentFile, "colors.xml").readText()
        val tokenColours = Regex("""<color name="token_([a-z_]+)">([^<]*)</color>""").findAll(colours).map { it.groupValues[1] to it.groupValues[2] }.toList()
        // Every colour named after a token is read, whatever it is written as.
        assertEquals(Regex("""name="token_""").findAll(colours).count(), tokenColours.size)
        assertTrue("colors.xml has the colours of the window and of the splash's mark", tokenColours.map { it.first }.containsAll(listOf("bg", "ink", "you")))
        for ((name, value) in tokenColours) assertEquals("token_$name in colors.xml", tokens.getString("--" + name.replace('_', '-')), value)
    }

    @Test
    fun `the system's splash draws the island of the app's mark`() {
        val drawable = File(File(System.getProperty("iamreal.strings.production")).parentFile.parentFile, "drawable/splash_mark.xml").readText()
        // Twice: its outline in the colour of the ground, then the island in ink.
        assertEquals(2, drawable.split("android:pathData=\"$TAIWAN_OUTLINE\"").size - 1)
    }

    @Test
    fun `the values the screens draw with are read from those tokens`() {
        assertEquals(0xFFBF2150.toInt(), Tokens.colour("--you"))
        assertEquals(28f, Tokens.px("--size-h2-phone"))
        assertEquals(1.85f, Tokens.number("--leading-body"))
    }
}
