package tw.iamreal.app.ui.demo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/**
 * The demonstration of hanging the link at given moments: the answers of spec/vectors/teaching-animation.json, which the
 * site's player and the iOS app are tested against too (design/motion/README.md). The timeline is the file the vectors
 * name, design/motion/hang.json: the one the installer carries.
 */
class HangMotionTest {
    private val vectors = JSONObject(File(System.getProperty("iamreal.vectors"), "teaching-animation.json").readText())
    private val repo = File(System.getProperty("iamreal.vectors")).resolve("../..").normalize()
    private val timeline = HangTimeline(File(repo, vectors.getJSONObject("timelines").getString("hang")).readText())
    private val tolerance = vectors.getDouble("tolerance")

    private fun same(what: String, want: Double, got: Double) = assertTrue("$what: $got, not $want", abs(want - got) <= tolerance)

    private fun numbers(what: String, want: JSONObject, got: Map<String, Double>) {
        assertEquals(what, want.keys().asSequence().toSet(), got.keys)
        for (name in want.keys()) same("$what.$name", want.getDouble(name), got.getValue(name))
    }

    @Test
    fun `the states are the answers of the vectors`() {
        val cases = vectors.getJSONArray("hang")
        assertTrue(cases.length() > 20)
        val variants = mutableSetOf<String>()
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val name = case.getString("name")
            val variant = case.getString("variant")
            variants += variant
            val want = case.getJSONObject("state")
            val got = hangStateAt(timeline, variant, case.getDouble("seconds"))

            val camera = want.getJSONObject("camera")
            assertEquals("$name: camera", listOf(camera.getString("from"), camera.getString("to")), listOf(got.camera.from, got.camera.to))
            same("$name: camera.progress", camera.getDouble("progress"), got.camera.progress)
            numbers("$name: marks", want.getJSONObject("marks"), got.marks)
            numbers("$name: states", want.getJSONObject("states"), got.states)
            assertEquals("$name: step", want.getInt("step"), got.step)
            val tap = got.tap
            if (want.isNull("tap")) {
                assertEquals("$name: tap", null, tap?.target)
            } else {
                val pressed = want.getJSONObject("tap")
                assertEquals("$name: tap.target", pressed.getString("target"), tap?.target)
                same("$name: tap.pressed", pressed.getDouble("pressed"), tap!!.pressed)
                same("$name: tap.ring.scale", pressed.getJSONObject("ring").getDouble("scale"), tap.ring.scale)
                same("$name: tap.ring.opacity", pressed.getJSONObject("ring").getDouble("opacity"), tap.ring.opacity)
            }
        }
        assertEquals("both platforms have answers", setOf("ios", "android"), variants)
    }

    @Test
    fun `any moment can be asked in any order, and a moment asked twice is the same`() {
        val late = hangStateAt(timeline, "android", 16.7)
        hangStateAt(timeline, "android", 0.0)
        val again = hangStateAt(timeline, "android", 16.7)
        assertEquals(listOf(late.camera.to, late.tap?.target, late.step), listOf(again.camera.to, again.tap?.target, again.step))
        // The way back on Android: the cross at the top left, not what is at the top right.
        assertEquals("x3", late.tap?.target)
        assertEquals("done3", hangStateAt(timeline, "ios", 16.7).tap?.target)
    }

    @Test
    fun `every box and framing an event names is the timeline's own`() {
        for (e in timeline.events) {
            when (e) {
                is HangEvent.Camera -> assertTrue(e.frame, timeline.own("android", e.frame) in timeline.frames)
                is HangEvent.Mark -> assertTrue(e.target, timeline.own("android", e.target) in timeline.boxes)
                is HangEvent.Unmark -> assertTrue(e.target, timeline.own("android", e.target) in timeline.boxes)
                is HangEvent.Tap -> assertTrue(e.target, timeline.own("android", e.target) in timeline.boxes)
                is HangEvent.Change -> assertTrue(e.state, e.state in timeline.states)
                is HangEvent.Step -> assertTrue("step ${e.step}", e.step in 0..5)
            }
        }
        for (frame in timeline.frames.values) assertTrue(frame.x.t in timeline.boxes && frame.y.t in timeline.boxes)
    }
}
