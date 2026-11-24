package tw.iamreal.app.reminder

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeParseException

/** How often the reminder comes (issue #93): a whole number of weeks, so it falls on the same day of the week. */
enum class Interval(val weeks: Long) { WEEKS_4(4), WEEKS_12(12), WEEKS_26(26) }

/** A reminder that is on: how often, at what time, and the day of the next one. */
data class Plan(val interval: Interval, val time: LocalTime, val day: LocalDate) {
    /** When the notification comes, on the phone's clock. */
    val at: LocalDateTime get() = day.atTime(time)
}

/** Where the phone keeps the reminder: the app's own preferences. */
interface Storage {
    fun read(): Map<String, String>

    /** Replaces everything stored with [values]; empty deletes it all. */
    fun write(values: Map<String, String>)
}

/** The system's alarm that posts the notification. */
interface Alarm {
    /** At [at], on the phone's clock and in its time zone; replaces an alarm set before. */
    fun set(at: LocalDateTime)

    fun cancel()
}

/**
 * The reminder to come back for a card proof (issue #93): a notification the phone schedules itself.
 * Nothing of it goes to a server. While it is on the phone stores four things (that it is on, the
 * interval, the time, the day of the next one; design/copy/app.md, "設定"), and nothing at all once it
 * is turned off: no account, short ID, link or date of a card proof, ever.
 *
 * Every day is the phone's, in its own time zone: the caller says what today is.
 */
class Reminders(private val storage: Storage, private val alarm: Alarm) {
    /** The reminder that is on, or null: off, never turned on, or stored in a way this app cannot read. */
    val plan: Plan?
        get() {
            val v = storage.read()
            if (v[ON] != "true") return null
            return try {
                Plan(Interval.valueOf(v[INTERVAL] ?: return null), LocalTime.parse(v[TIME] ?: return null), LocalDate.parse(v[DAY] ?: return null))
            } catch (e: IllegalArgumentException) {
                null
            } catch (e: DateTimeParseException) {
                null
            }
        }

    /** Turns the reminder on, or changes it: [picked] if a day was picked (for this once), else [interval] from [today]. */
    fun turnOn(interval: Interval, time: LocalTime, picked: LocalDate?, today: LocalDate): Plan {
        require(picked == null || picked in pickable(today)) { "a day that cannot be picked" }
        return set(Plan(interval, time, picked ?: next(today, interval)))
    }

    /**
     * The day a change on the screen of the interval and the time would set ([change]): [picked] if a day was
     * picked; the day already set if only the time changed and it is still to come; else [interval] from today.
     */
    fun dayFor(interval: Interval, time: LocalTime, picked: LocalDate?, now: LocalDateTime): LocalDate {
        if (picked != null) return picked
        val p = plan
        if (p != null && interval == p.interval && !passed(now) && p.day.atTime(time).isAfter(now)) return p.day
        return next(now.toLocalDate(), interval)
    }

    /** Turns the reminder on, or changes it, as the screen of the interval and the time shows it ([dayFor]). */
    fun change(interval: Interval, time: LocalTime, picked: LocalDate?, now: LocalDateTime): Plan {
        if (picked != null) return turnOn(interval, time, picked, now.toLocalDate())
        return set(Plan(interval, time, dayFor(interval, time, null, now)))
    }

    /** Turns the reminder off: the alarm is cancelled and nothing of it is left on the phone. */
    fun turnOff() {
        alarm.cancel()
        storage.write(emptyMap())
    }

    /** A card proof was completed [today]: a reminder that is on comes again by its interval. Returns it, or null if off. */
    fun afterCardProof(today: LocalDate): Plan? = plan?.let { set(it.copy(day = next(today, it.interval))) }

    /** "一週後再提醒我": 7 days from [today], at the same time. The interval is kept. Null if the reminder is off. */
    fun snooze(today: LocalDate): Plan? = plan?.let { set(it.copy(day = today.plusDays(SNOOZE_DAYS))) }

    /** Sets the alarm again, as after the phone restarted (the system forgets alarms then): only for a reminder still to come. */
    fun rearm(now: LocalDateTime) {
        val p = plan ?: return
        if (!passed(now)) alarm.set(p.at)
    }

    /**
     * The reminder came while the phone was off (the system forgets alarms then): within the last day it is
     * notified once the phone is on again. The phone does not store whether it was notified, so a phone that
     * restarts on the evening it was notified is notified again.
     */
    fun missed(now: LocalDateTime): Boolean = plan?.let { passed(now) && it.at.isAfter(now.minusDays(1)) } ?: false

    /** The reminder that is on came already, or comes at [now]: nothing more until the next card proof or snooze. */
    fun passed(now: LocalDateTime): Boolean = plan?.let { !it.at.isAfter(now) } ?: false

    private fun set(plan: Plan): Plan {
        storage.write(mapOf(ON to "true", INTERVAL to plan.interval.name, TIME to plan.time.toString(), DAY to plan.day.toString()))
        alarm.set(plan.at)
        return plan
    }

    companion object {
        /** The time a reminder comes unless another is chosen: a card is mostly at home, in the evening. */
        val DEFAULT_TIME: LocalTime = LocalTime.of(21, 0)

        val DEFAULT_INTERVAL = Interval.WEEKS_12

        /** The next reminder by [interval], from [today]. */
        fun next(today: LocalDate, interval: Interval): LocalDate = today.plusWeeks(interval.weeks)

        /** The days that can be picked for the next reminder: tomorrow to a year from [today]. */
        fun pickable(today: LocalDate): ClosedRange<LocalDate> = today.plusDays(1)..today.plusYears(1)

        private const val SNOOZE_DAYS = 7L
        private const val ON = "on"
        private const val INTERVAL = "interval"
        private const val TIME = "time"
        private const val DAY = "day"
    }
}
