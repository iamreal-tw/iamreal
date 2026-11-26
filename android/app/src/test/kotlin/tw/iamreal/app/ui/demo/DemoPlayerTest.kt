package tw.iamreal.app.ui.demo

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The time of a demonstration as the frames of the system move it on: by the clock, however slowly the phone draws,
 * and not by the time the app was away.
 */
class DemoPlayerTest {
    private val ms = 1_000_000L

    private fun playing(length: Double = 20.7) = DemoPlayer(length).apply { play() }

    @Test
    fun `sixty frames a second, a second of frames is a second of the demonstration`() {
        val player = playing()
        repeat(60) { player.frame(1_000_000_000L / 60) }
        assertEquals(1.0, player.seconds, 1e-6)
    }

    @Test
    fun `a phone that draws five frames a second keeps to the clock`() {
        // Each frame 200 ms after the last: the whole 200 ms, not a tenth of a second of it.
        val player = playing()
        repeat(5) { player.frame(200 * ms) }
        assertEquals(1.0, player.seconds, 1e-6)
        // And it is over when its length has passed, not half as long again later.
        repeat(5 * 20) { player.frame(200 * ms) }
        assertEquals(listOf<Any>(20.7, false), listOf(player.seconds, player.playing))
    }

    @Test
    fun `the time the app was away is not time of the demonstration`() {
        val player = playing()
        player.frame(16 * ms)
        // A minute in the background: the next frame moves it on a second at most, and it goes on from there.
        player.frame(60_000 * ms)
        assertEquals(1.016, player.seconds, 1e-6)
        assertEquals(true, player.playing)
    }

    @Test
    fun `the last frame stops it at its end`() {
        val player = playing(length = 1.0)
        player.frame(600 * ms)
        assertEquals(true, player.playing)
        player.frame(600 * ms)
        assertEquals(listOf<Any>(1.0, false), listOf(player.seconds, player.playing))
        // Played again: from the start.
        player.play()
        assertEquals(listOf<Any>(0.0, true), listOf(player.seconds, player.playing))
    }
}
