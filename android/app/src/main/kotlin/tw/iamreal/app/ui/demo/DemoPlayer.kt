package tw.iamreal.app.ui.demo

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos

/**
 * The time of a demonstration ([length] seconds of it) and whether it plays: what its one button changes
 * (design/copy/card-proof.md, "示範"). The picture is worked out from [seconds] alone.
 */
internal open class DemoPlayer(val length: Double) {
    var seconds by mutableDoubleStateOf(0.0)
        private set
    var playing by mutableStateOf(false)
        private set

    /** It has played, or was stopped: it does not start by itself again. */
    private var started = false

    /** By itself, the first time only. */
    fun playOnce() {
        if (started) return
        play()
    }

    /** "再看一次": from the start. */
    fun play() {
        started = true
        seconds = 0.0
        playing = true
    }

    /** "停止播放": straight to the last frame. */
    fun stop() {
        started = true
        seconds = length
        playing = false
    }

    /**
     * A frame of the system's, [sinceLast] nanoseconds after the one before: the demonstration is that much further on,
     * and stops at its end. It keeps to the clock on a phone that draws slowly: a frame that comes late moves it on by
     * all the time that passed. Of a wait longer than [LONGEST_FRAME] only that much counts: the app was away, and
     * the demonstration goes on from about where it was left.
     */
    fun frame(sinceLast: Long) {
        val by = minOf(sinceLast, LONGEST_FRAME) / 1e9
        if (seconds + by >= length) stop() else seconds += by
    }

    companion object {
        /**
         * The most one frame moves a demonstration on, in nanoseconds: a second. No phone draws so slowly, so anything
         * longer is the app in the background. Not less: a limit near the time between two frames makes the
         * demonstration run behind the clock on a phone that draws slowly.
         */
        const val LONGEST_FRAME = 1_000_000_000L
    }
}

/**
 * Keeps [player]'s time while it plays, by the frames the system gives (withFrameNanos). Frame by frame from where it
 * is: a screen left and come back to goes on from there, and the time the app was away is not time of the
 * demonstration ([DemoPlayer.frame]). The system's setting that turns animations off does not stop it (issue #369): the button does.
 */
@Composable
internal fun Frames(player: DemoPlayer) {
    LaunchedEffect(player, player.playing) {
        if (!player.playing) return@LaunchedEffect
        var last = withFrameNanos { it }
        while (player.playing) {
            val now = withFrameNanos { it }
            player.frame(now - last)
            last = now
        }
    }
}
