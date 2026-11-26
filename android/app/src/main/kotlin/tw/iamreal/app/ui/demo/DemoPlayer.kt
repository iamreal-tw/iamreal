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

    /** "停止": straight to the last frame. */
    fun stop() {
        started = true
        seconds = length
        playing = false
    }

    /** A frame of the system's: the demonstration is [by] seconds further on, and stops at its end. */
    fun advance(by: Double) {
        if (seconds + by >= length) stop() else seconds += by
    }
}

/** The most one frame moves a demonstration on, in nanoseconds: a wait longer than this was the app being away. */
private const val LONGEST_FRAME = 100_000_000L

/**
 * Keeps [player]'s time while it plays, by the frames the system gives (withFrameNanos). Frame by frame from where it
 * is: a screen left and come back to goes on from there, and a long wait between two frames is not time of the
 * demonstration. The system's setting that turns animations off does not stop it (issue #369): the button does.
 */
@Composable
internal fun Frames(player: DemoPlayer) {
    LaunchedEffect(player, player.playing) {
        if (!player.playing) return@LaunchedEffect
        var last = withFrameNanos { it }
        while (player.playing) {
            val now = withFrameNanos { it }
            player.advance(minOf(now - last, LONGEST_FRAME) / 1e9)
            last = now
        }
    }
}
