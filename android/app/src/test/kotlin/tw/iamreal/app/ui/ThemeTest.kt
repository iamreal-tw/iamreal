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
 * design/copy/, which the build hands the tests (app/build.gradle.kts). And
 * the mark the system's splash and the launcher's icon draw (res/drawable/).
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
        val colours = File(File(System.getProperty("iamreal.strings.store")).parentFile, "colors.xml").readText()
        val tokenColours = Regex("""<color name="token_([a-z_]+)">([^<]*)</color>""").findAll(colours).map { it.groupValues[1] to it.groupValues[2] }.toList()
        // Every colour named after a token is read, whatever it is written as.
        assertEquals(Regex("""name="token_""").findAll(colours).count(), tokenColours.size)
        assertTrue("colors.xml has the colours of the window and of the splash's mark", tokenColours.map { it.first }.containsAll(listOf("bg", "ink", "you")))
        for ((name, value) in tokenColours) assertEquals("token_$name in colors.xml", tokens.getString("--" + name.replace('_', '-')), value)
    }

    @Test
    fun `the system's splash draws the island of the app's mark`() {
        val drawable = File(File(System.getProperty("iamreal.strings.store")).parentFile.parentFile, "drawable/splash_mark.xml").readText()
        // Twice: its outline in the colour of the ground, then the island in ink.
        assertEquals(2, drawable.split("android:pathData=\"$TAIWAN_OUTLINE\"").size - 1)
    }

    @Test
    fun `the launcher's icon is the mark on the page's white, inside the circle every launcher keeps`() {
        val res = File(System.getProperty("iamreal.strings.store")).parentFile.parentFile
        val icon = File(res, "mipmap-anydpi/ic_launcher.xml").readText()
        assertTrue("the icon's ground is token_bg", icon.contains("""<background android:drawable="@color/token_bg" />"""))
        assertTrue("the icon's foreground is launcher_mark", icon.contains("""<foreground android:drawable="@drawable/launcher_mark" />"""))
        val mark = File(res, "drawable/launcher_mark.xml").readText()
        // The same card and island as the splash's, drawn the same way: only where the whole mark is put differs.
        fun drawing(xml: String): String = xml.replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "").replace(Regex("\\s+"), " ")
            .substringAfter("<group android:pivotX=\"27\"", "")
        assertTrue("launcher_mark.xml draws a card turned about (27, 39)", drawing(mark).isNotEmpty())
        assertEquals("launcher_mark.xml's mark", drawing(File(res, "drawable/splash_mark.xml").readText()), drawing(mark))
        // Where the mark is put on the layer of 108dp, and the points it reaches: the island's, and the corners of the
        // card turned -9° about (27, 39) (its rounded corners reach less far). A launcher keeps the circle of 66dp in
        // the middle, whatever shape it masks the icon to.
        val (scale, x0, y0) = Regex("""android:name="mark"\s+android:scaleX="([0-9.]+)"\s+android:scaleY="\1"\s+android:translateX="([0-9.]+)"\s+android:translateY="([0-9.]+)"""")
            .find(mark)!!.destructured.toList().map { it.toDouble() }
        val island = Regex("""([0-9.]+) ([0-9.]+)""").findAll(TAIWAN_OUTLINE).map { 31.5 + 0.97 * it.groupValues[1].toDouble() to 3 + 0.97 * it.groupValues[2].toDouble() }
        val turn = Math.toRadians(-9.0)
        val card = listOf(3.0 to 24.0, 49.0 to 24.0, 49.0 to 54.0, 3.0 to 54.0).map { (x, y) ->
            27 + (x - 27) * Math.cos(turn) - (y - 39) * Math.sin(turn) to 39 + (x - 27) * Math.sin(turn) + (y - 39) * Math.cos(turn)
        }
        for ((x, y) in island + card) {
            val r = Math.hypot(x0 + scale * x - 54, y0 + scale * y - 54)
            assertTrue("($x, $y) of the mark is ${"%.1f".format(r)}dp from the middle, outside the circle of 66dp", r <= 33)
        }
    }

    @Test
    fun `the values the screens draw with are read from those tokens`() {
        assertEquals(0xFFBF2150.toInt(), Tokens.colour("--you"))
        assertEquals(28f, Tokens.px("--size-h2-phone"))
        assertEquals(1.85f, Tokens.number("--leading-body"))
    }
}
