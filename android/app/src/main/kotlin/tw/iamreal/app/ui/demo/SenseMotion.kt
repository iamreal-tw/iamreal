package tw.iamreal.app.ui.demo

import org.json.JSONObject

// The demonstration of where the card goes on the phone (design/motion/sense.json) at one moment: given the timeline,
// the platform and a number of seconds, what the picture is then. design/motion/README.md says what each value means;
// spec/vectors/teaching-animation.json holds the answers this file, the site's (worker/src/teaching-animation.ts) and
// the iOS app's are tested against.
//
// Pure: no clock, no screen, nothing kept between two calls.

/** An event of a round, [at] seconds after the round starts. */
internal sealed class SenseEvent {
    abstract val at: Double
    abstract val dur: Double

    /** The card comes in from the right at the height [y], fading in. */
    class Enter(override val at: Double, val y: Double, override val dur: Double) : SenseEvent()

    /** The card moves to the height [y]. */
    class Move(override val at: Double, val y: Double, override val dur: Double) : SenseEvent()

    /** The phone reads the card: a ring. */
    class Ring(override val at: Double, override val dur: Double) : SenseEvent()

    /** The card fades out where it is; the last round does not leave. */
    class Leave(override val at: Double, override val dur: Double) : SenseEvent()
}

/** design/motion/sense.json, as the installer carries it, for one platform ([variant]: "ios" or "android"). */
internal class SenseTimeline(json: String, variant: String) {
    private val o = JSONObject(json)

    /** How many rounds are played before the picture rests. */
    val rounds: Int = o.getInt("rounds")

    /** How many phone widths to the right the card comes in from. */
    val enterFrom: Double = o.getJSONObject("enter").getDouble("from")
    val ringFrom: Double = o.getJSONObject("ring").getDouble("from")
    val ringTo: Double = o.getJSONObject("ring").getDouble("to")
    private val own = o.getJSONObject("variants").optJSONObject(variant) ?: throw IllegalArgumentException("no variant $variant")

    /** How long a round is. */
    val duration: Double = own.getDouble("duration")
    val events: List<SenseEvent> = own.getJSONArray("events").let { list ->
        (0 until list.length()).map { i ->
            val e = list.getJSONObject(i)
            val at = e.getDouble("at")
            val dur = e.getDouble("dur")
            when (val kind = e.getString("do")) {
                "enter" -> SenseEvent.Enter(at, e.getDouble("y"), dur)
                "move" -> SenseEvent.Move(at, e.getDouble("y"), dur)
                "ring" -> SenseEvent.Ring(at, dur)
                "leave" -> SenseEvent.Leave(at, dur)
                else -> throw IllegalArgumentException("an event that does $kind")
            }
        }
    }

    /** How long the picture plays before it rests: every round but the last whole, the last up to where it would leave. */
    val length: Double = duration * (rounds - 1) + (events.firstOrNull { it is SenseEvent.Leave }?.at ?: duration)
}

/** The card's centre: [y] down the phone (0 its top, 1 its bottom), [x] phone widths to the right of its place; and how much of it shows. */
internal class CardAt(val y: Double, val x: Double, val opacity: Double)

internal class SenseState(
    /** 1 for the first round. */
    val round: Int,
    /** True from the moment the last round rests. */
    val stopped: Boolean,
    val card: CardAt,
    /** Null when there is no ring. */
    val ring: Ring?,
)

/** The picture of where the card goes, [seconds] after it starts. */
internal fun senseStateAt(timeline: SenseTimeline, seconds: Double): SenseState {
    // Before the start is the start, after the end is the end.
    val t = if (seconds > 0) minOf(seconds, timeline.length) else 0.0
    val round = minOf(timeline.rounds, (t / timeline.duration).toInt() + 1)
    val local = t - (round - 1) * timeline.duration

    var y = 0.0
    var x = timeline.enterFrom
    var opacity = 0.0
    var ring: Ring? = null
    var placed = false
    for (e in timeline.events) {
        // Before the card comes in it waits, unseen, to the right of where it will come in.
        if (e is SenseEvent.Enter && !placed) {
            y = e.y
            placed = true
        }
        if (e.at > local) continue
        val dt = local - e.at
        val gone = if (e.dur > 0) minOf(1.0, dt / e.dur) else 1.0
        when (e) {
            is SenseEvent.Enter -> {
                val p = easeOut(gone)
                x = timeline.enterFrom * (1 - p)
                opacity = p
            }
            is SenseEvent.Move -> y += (e.y - y) * easeInOut(gone)
            is SenseEvent.Ring -> if (dt < e.dur) {
                val p = easeOut(dt / e.dur)
                ring = Ring(timeline.ringFrom + (timeline.ringTo - timeline.ringFrom) * p, 1 - p)
            }
            // The last round does not leave: the card stays where the phone read it.
            is SenseEvent.Leave -> if (round < timeline.rounds) opacity = 1 - gone
        }
    }
    return SenseState(round, t >= timeline.length, CardAt(y, x, opacity), ring)
}
