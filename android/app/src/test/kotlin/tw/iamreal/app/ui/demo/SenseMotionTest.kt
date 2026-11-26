package tw.iamreal.app.ui.demo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/**
 * The demonstration of where the card goes at given moments: the answers of spec/vectors/teaching-animation.json, which
 * the site's algorithm and the iOS app are tested against too (design/motion/README.md). The timeline is the file the
 * vectors name, design/motion/sense.json: the one the installer carries.
 */
class SenseMotionTest {
    private val vectors = JSONObject(File(System.getProperty("iamreal.vectors"), "teaching-animation.json").readText())
    private val repo = File(System.getProperty("iamreal.vectors")).resolve("../..").normalize()
    private val json = File(repo, vectors.getJSONObject("timelines").getString("sense")).readText()
    private val tolerance = vectors.getDouble("tolerance")

    private fun same(what: String, want: Double, got: Double) = assertTrue("$what: $got, not $want", abs(want - got) <= tolerance)

    @Test
    fun `the states are the answers of the vectors`() {
        val cases = vectors.getJSONArray("sense")
        assertTrue(cases.length() > 20)
        val variants = mutableSetOf<String>()
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val name = case.getString("name")
            val variant = case.getString("variant")
            variants += variant
            val want = case.getJSONObject("state")
            val got = senseStateAt(SenseTimeline(json, variant), case.getDouble("seconds"))
            assertEquals("$name: round", want.getInt("round"), got.round)
            assertEquals("$name: stopped", want.getBoolean("stopped"), got.stopped)
            val card = want.getJSONObject("card")
            same("$name: card.y", card.getDouble("y"), got.card.y)
            same("$name: card.x", card.getDouble("x"), got.card.x)
            same("$name: card.opacity", card.getDouble("opacity"), got.card.opacity)
            val ring = got.ring
            if (want.isNull("ring")) {
                assertEquals("$name: ring", null, ring?.scale)
            } else {
                same("$name: ring.scale", want.getJSONObject("ring").getDouble("scale"), ring!!.scale)
                same("$name: ring.opacity", want.getJSONObject("ring").getDouble("opacity"), ring.opacity)
            }
        }
        assertEquals("both platforms have answers", setOf("ios", "android"), variants)
    }

    @Test
    fun `at rest the card is where the phone read it, whole, with no ring, however long after`() {
        val timeline = SenseTimeline(json, "android")
        // Three rounds: two whole, the third up to where it would leave (design/motion/README.md).
        same("the length", 25.55, timeline.length)
        for (seconds in listOf(timeline.length, timeline.length + 60)) {
            val rest = senseStateAt(timeline, seconds)
            assertEquals(listOf<Any?>(3, true, null), listOf(rest.round, rest.stopped, rest.ring))
            same("the card's height", 0.375, rest.card.y)
            same("the card's place", 0.0, rest.card.x)
            same("the card", 1.0, rest.card.opacity)
        }
        // Before anything: the phone alone.
        same("the card before it comes in", 0.0, senseStateAt(timeline, 0.0).card.opacity)
    }
}
