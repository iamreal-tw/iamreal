package tw.iamreal.app.ui.demo

import org.json.JSONObject

// The demonstration of hanging the link on a profile (design/motion/hang.json) at one moment: given the timeline
// and a number of seconds, what the picture is then. design/motion/README.md says what each value means;
// spec/vectors/teaching-animation.json holds the answers this file, the site's player (worker/src/teaching-animation.ts)
// and the iOS app's are tested against.
//
// Pure: no clock, no screen, nothing kept between two calls, so any moment can be asked for in any order.

/** Where a box's point goes in the picture: point [a] (0 to 1) of the box [t] at [v] (0 to 1) of the picture. */
internal class Anchor(val t: String, val a: Double, val v: Double)

/** A framing of the camera: the picture is [span] units wide, and one point on each axis is pinned. */
internal class Frame(val span: Double, val x: Anchor, val y: Anchor)

/** An event of the timeline, [at] seconds after the start. */
internal sealed class HangEvent {
    abstract val at: Double

    /** The camera takes [dur] seconds from where it is to the framing [frame]. */
    class Camera(override val at: Double, val frame: String, val dur: Double) : HangEvent()

    /** The mark of the box [target] fades in. */
    class Mark(override val at: Double, val target: String) : HangEvent()

    /** The mark of the box [target] fades out. */
    class Unmark(override val at: Double, val target: String) : HangEvent()

    /** The box [target] is pressed; held [hold] seconds for a long press, 0 for a tap. */
    class Tap(override val at: Double, val target: String, val hold: Double) : HangEvent()

    /** A change of the screens, one of the timeline's `states`. */
    class Change(override val at: Double, val state: String) : HangEvent()

    /** Which of the written steps is being shown from here on. */
    class Step(override val at: Double, val step: Int) : HangEvent()
}

/** The numbers of a press (design/motion/README.md, "按"). */
internal class TapNumbers(
    val press: Double, val pressIn: Double, val pressHold: Double, val pressOut: Double,
    val ring: Double, val from: Double, val to: Double,
    val holdIn: Double, val holdAt: Double, val holdOut: Double,
)

/** design/motion/hang.json, as the installer carries it. */
internal class HangTimeline(json: String) {
    private val o = JSONObject(json)
    val duration: Double = o.getDouble("duration")

    /** The picture's width over its height. */
    val aspect: Float = o.getJSONObject("picture").let { (it.getDouble("width") / it.getDouble("height")).toFloat() }

    /** How many units wide one of the screens is: the unit of a framing's span. */
    val screen: Double = o.getDouble("screen")
    val start: String = o.getString("start")
    val markFade: Double = o.getJSONObject("mark").getDouble("fade")
    val tap: TapNumbers = o.getJSONObject("tap").let { t ->
        TapNumbers(
            t.getDouble("press"), t.getDouble("pressIn"), t.getDouble("pressHold"), t.getDouble("pressOut"),
            t.getDouble("ring"), t.getDouble("from"), t.getDouble("to"),
            t.getDouble("holdIn"), t.getDouble("holdAt"), t.getDouble("holdOut"),
        )
    }

    /** How long each change of the screens takes, in the file's order. */
    val states: Map<String, Double> = o.getJSONObject("states").let { s -> s.keys().asSequence().associateWith { s.getDouble(it) } }

    /** Each platform's own names: what an event's `back` is there. */
    val variants: Map<String, Map<String, String>> = o.getJSONObject("variants").let { v ->
        v.keys().asSequence().associateWith { name -> v.getJSONObject(name).let { own -> own.keys().asSequence().associateWith { own.getString(it) } } }
    }

    /** The names of the boxes the screens must have. */
    val boxes: Set<String> = o.getJSONObject("boxes").keys().asSequence().toSet()
    val frames: Map<String, Frame> = o.getJSONObject("frames").let { f ->
        f.keys().asSequence().associateWith { name ->
            val frame = f.getJSONObject(name)
            val anchor = { axis: String -> frame.getJSONObject(axis).let { Anchor(it.getString("t"), it.getDouble("a"), it.getDouble("v")) } }
            Frame(frame.getDouble("span"), anchor("x"), anchor("y"))
        }
    }
    val events: List<HangEvent> = o.getJSONArray("events").let { list ->
        (0 until list.length()).map { i ->
            val e = list.getJSONObject(i)
            val at = e.getDouble("at")
            when (val kind = e.getString("do")) {
                "camera" -> HangEvent.Camera(at, e.getString("frame"), e.getDouble("dur"))
                "mark" -> HangEvent.Mark(at, e.getString("target"))
                "unmark" -> HangEvent.Unmark(at, e.getString("target"))
                "tap" -> HangEvent.Tap(at, e.getString("target"), e.optDouble("hold", 0.0))
                "state" -> HangEvent.Change(at, e.getString("state"))
                "step" -> HangEvent.Step(at, e.getInt("step"))
                else -> throw IllegalArgumentException("an event that does $kind")
            }
        }
    }

    /** The platform's own name of a box or a framing an event names: [name] itself, but for `back`. */
    fun own(variant: String, name: String): String = (variants[variant] ?: throw IllegalArgumentException("no variant $variant"))[name] ?: name
}

/** A ring: how many times its own size, and how much of it shows. */
internal class Ring(val scale: Double, val opacity: Double)

/** The box being pressed, how far down it is (0 to 1) and its ring. */
internal class Pressed(val target: String, val pressed: Double, val ring: Ring)

/** The camera is [progress] of the way from the framing [from] to the framing [to]. */
internal class CameraAt(val from: String, val to: String, val progress: Double)

internal class HangState(
    val camera: CameraAt,
    /** How much the mark of each box shows, above 0 to 1; a box that is not here has none. */
    val marks: Map<String, Double>,
    /** Null when nothing is pressed. */
    val tap: Pressed?,
    /** How far each change of the screens has gone, 0 to 1: every one of the timeline's. */
    val states: Map<String, Double>,
    /** Which of the written steps is being shown: 0 the buttons, 1 to 4 the steps, 5 the result. */
    val step: Int,
)

/** Cubic ease in and out: the camera. */
internal fun easeInOut(p: Double): Double {
    if (p < 0.5) return 4 * p * p * p
    val q = -2 * p + 2
    return 1 - q * q * q / 2
}

/** Quintic ease out: the rings, and the changes of the screens. */
internal fun easeOut(p: Double): Double {
    val q = 1 - p
    return 1 - q * q * q * q * q
}

/** How far a change that started at [at] and takes [dur] has gone at [t], up to 1; one that takes no time is done at once. */
private fun gone(t: Double, at: Double, dur: Double): Double = if (dur > 0) minOf(1.0, (t - at) / dur) else 1.0

/** The picture of hanging the link, [seconds] after it starts, for the platform [variant] ("ios" or "android"). */
internal fun hangStateAt(timeline: HangTimeline, variant: String, seconds: Double): HangState {
    // Before the start is the start, after the end is the end.
    val t = if (seconds > 0) minOf(seconds, timeline.duration) else 0.0
    val tap = timeline.tap
    var camera = CameraAt(timeline.start, timeline.start, 1.0)
    val marks = LinkedHashMap<String, Double>()
    var pressed: Pressed? = null
    val states = LinkedHashMap<String, Double>()
    for (name in timeline.states.keys) states[name] = 0.0
    var step = 0

    for (e in timeline.events) {
        if (e.at > t) break
        val dt = t - e.at
        when (e) {
            is HangEvent.Camera -> camera = CameraAt(camera.to, timeline.own(variant, e.frame), easeInOut(gone(t, e.at, e.dur)))
            is HangEvent.Mark -> marks[timeline.own(variant, e.target)] = gone(t, e.at, timeline.markFade)
            is HangEvent.Unmark -> marks[timeline.own(variant, e.target)] = 1 - gone(t, e.at, timeline.markFade)
            is HangEvent.Change -> states[e.state] = easeOut(gone(t, e.at, timeline.states[e.state] ?: 0.0))
            is HangEvent.Step -> step = e.step
            is HangEvent.Tap -> {
                val hold = e.hold
                // The ring of a tap goes out at once; the ring of a long press grows, waits for the finger, then goes out.
                val over = hold + maxOf(if (hold > 0) tap.holdOut else tap.ring, tap.pressHold + tap.pressOut)
                if (dt >= over) {
                    pressed = null
                } else {
                    val down = when {
                        dt < tap.pressIn -> dt / tap.pressIn
                        dt < tap.pressHold + hold -> 1.0
                        else -> maxOf(0.0, 1 - (dt - tap.pressHold - hold) / tap.pressOut)
                    }
                    val ring = if (hold > 0 && dt < hold) {
                        val p = easeOut(gone(dt, 0.0, tap.holdIn))
                        Ring(tap.from + (tap.holdAt - tap.from) * p, p)
                    } else {
                        val p = if (hold > 0) easeOut(gone(dt, hold, tap.holdOut)) else easeOut(gone(dt, 0.0, tap.ring))
                        val from = if (hold > 0) tap.holdAt else tap.from
                        Ring(from + (tap.to - from) * p, 1 - p)
                    }
                    pressed = Pressed(timeline.own(variant, e.target), down, ring)
                }
            }
        }
    }
    return HangState(camera, marks.filterValues { it > 0 }, pressed, states, step)
}
