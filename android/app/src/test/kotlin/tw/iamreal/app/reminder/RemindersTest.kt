package tw.iamreal.app.reminder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

/**
 * When the next reminder is (issue #93): from today, on the same day of the week, at the time chosen. Nothing
 * here asks the system for a notification: the alarm is a fake that notes what it was asked.
 */
class RemindersTest {
    /** A Monday: the example of design/copy/card-proof.md. */
    private val monday = LocalDate.parse("2026-11-16")
    private val nine = LocalTime.of(21, 0)

    @Test
    fun `turned on with the defaults, the reminder is 12 weeks on, a Monday, at 9 in the evening`() {
        val alarm = FakeAlarm()
        val plan = Reminders(MemoryStorage(), alarm).turnOn(Interval.WEEKS_12, nine, picked = null, today = monday)
        assertEquals(LocalDate.parse("2027-02-08"), plan.day)
        assertEquals(LocalDateTime.parse("2027-02-08T21:00"), alarm.at)
    }

    @Test
    fun `a month is 4 weeks and six months 26, from today, on the same day of the week`() {
        val reminders = Reminders(MemoryStorage(), FakeAlarm())
        assertEquals(LocalDate.parse("2026-12-14"), reminders.turnOn(Interval.WEEKS_4, nine, null, monday).day)
        assertEquals(LocalDate.parse("2027-05-17"), reminders.turnOn(Interval.WEEKS_26, nine, null, monday).day)
        // A Thursday stays a Thursday.
        assertEquals(LocalDate.parse("2027-02-25"), reminders.turnOn(Interval.WEEKS_12, nine, null, LocalDate.parse("2026-12-03")).day)
    }

    @Test
    fun `a day picked is the next reminder, at the time chosen`() {
        val alarm = FakeAlarm()
        val plan = Reminders(MemoryStorage(), alarm).turnOn(Interval.WEEKS_12, LocalTime.of(7, 30), LocalDate.parse("2027-01-01"), monday)
        assertEquals(LocalDate.parse("2027-01-01"), plan.day)
        assertEquals(LocalDateTime.parse("2027-01-01T07:30"), alarm.at)
    }

    @Test
    fun `the days that can be picked are tomorrow to a year from today`() {
        assertEquals(LocalDate.parse("2026-11-17")..LocalDate.parse("2027-11-16"), Reminders.pickable(monday))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `today cannot be picked`() {
        Reminders(MemoryStorage(), FakeAlarm()).turnOn(Interval.WEEKS_12, nine, monday, monday)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a day more than a year away cannot be picked`() {
        Reminders(MemoryStorage(), FakeAlarm()).turnOn(Interval.WEEKS_12, nine, LocalDate.parse("2027-11-17"), monday)
    }

    @Test
    fun `the phone stores four things while the reminder is on, and the app reads them back`() {
        val storage = MemoryStorage()
        Reminders(storage, FakeAlarm()).turnOn(Interval.WEEKS_4, LocalTime.of(20, 15), null, monday)
        assertEquals(mapOf("on" to "true", "interval" to "WEEKS_4", "time" to "20:15", "day" to "2026-12-14"), storage.values)
        assertEquals(Plan(Interval.WEEKS_4, LocalTime.of(20, 15), LocalDate.parse("2026-12-14")), Reminders(storage, FakeAlarm()).plan)
    }

    @Test
    fun `turned off, the phone keeps nothing of the reminder and no alarm is left`() {
        val storage = MemoryStorage()
        val alarm = FakeAlarm()
        val reminders = Reminders(storage, alarm)
        reminders.turnOn(Interval.WEEKS_12, nine, null, monday)
        reminders.turnOff()
        assertEquals(emptyMap<String, String>(), storage.values)
        assertNull(alarm.at)
        assertNull(reminders.plan)
    }

    @Test
    fun `nothing stored, or something the app cannot read, is a reminder that is off`() {
        assertNull(Reminders(MemoryStorage(), FakeAlarm()).plan)
        val storage = MemoryStorage().apply { values.putAll(mapOf("on" to "true", "interval" to "WEEKS_5", "time" to "21:00", "day" to "2027-02-08")) }
        assertNull(Reminders(storage, FakeAlarm()).plan)
    }

    @Test
    fun `after a card proof the reminder is set again from that day, by the interval last chosen`() {
        val storage = MemoryStorage()
        val alarm = FakeAlarm()
        // A day was picked once; the card proof after it goes back to the interval.
        Reminders(storage, alarm).turnOn(Interval.WEEKS_26, LocalTime.of(19, 0), LocalDate.parse("2026-12-01"), monday)
        val plan = Reminders(storage, alarm).afterCardProof(LocalDate.parse("2026-12-01"))
        assertEquals(Plan(Interval.WEEKS_26, LocalTime.of(19, 0), LocalDate.parse("2027-06-01")), plan)
        assertEquals(LocalDateTime.parse("2027-06-01T19:00"), alarm.at)
        assertEquals("2027-06-01", storage.values["day"])
    }

    @Test
    fun `after a card proof with the reminder off, nothing is stored and no alarm set`() {
        val storage = MemoryStorage()
        val alarm = FakeAlarm()
        assertNull(Reminders(storage, alarm).afterCardProof(monday))
        assertEquals(emptyMap<String, String>(), storage.values)
        assertNull(alarm.at)
    }

    @Test
    fun `一週後再提醒我 is 7 days from today at the same time, as many times as it is pressed`() {
        val storage = MemoryStorage()
        val alarm = FakeAlarm()
        val reminders = Reminders(storage, alarm)
        reminders.turnOn(Interval.WEEKS_12, nine, null, monday)
        assertEquals(LocalDate.parse("2027-02-15"), reminders.snooze(LocalDate.parse("2027-02-08"))?.day)
        assertEquals(LocalDate.parse("2027-02-22"), reminders.snooze(LocalDate.parse("2027-02-15"))?.day)
        assertEquals(LocalDateTime.parse("2027-02-22T21:00"), alarm.at)
        // The interval is kept for the next card proof.
        assertEquals(Interval.WEEKS_12, Reminders(storage, alarm).plan?.interval)
    }

    @Test
    fun `一週後再提醒我 with the reminder off does nothing`() {
        val storage = MemoryStorage()
        assertNull(Reminders(storage, FakeAlarm()).snooze(monday))
        assertEquals(emptyMap<String, String>(), storage.values)
    }

    @Test
    fun `a reminder that came while the phone was off is notified once it is on again, within a day`() {
        val storage = MemoryStorage()
        Reminders(storage, FakeAlarm()).turnOn(Interval.WEEKS_12, nine, null, monday)
        val reminders = Reminders(storage, FakeAlarm())
        assertTrue(reminders.missed(LocalDateTime.parse("2027-02-08T23:30")))
        assertTrue(reminders.missed(LocalDateTime.parse("2027-02-09T20:59")))
        // More than a day late: the next card proof sets it again.
        assertFalse(reminders.missed(LocalDateTime.parse("2027-02-09T21:01")))
        // Not come yet: the alarm does it.
        assertFalse(reminders.missed(LocalDateTime.parse("2027-02-08T20:59")))
        assertFalse(Reminders(MemoryStorage(), FakeAlarm()).missed(LocalDateTime.parse("2027-02-08T23:30")))
    }

    @Test
    fun `changing only the time keeps the day, changing the interval counts from today`() {
        val storage = MemoryStorage()
        val alarm = FakeAlarm()
        val reminders = Reminders(storage, alarm)
        reminders.turnOn(Interval.WEEKS_12, nine, null, monday)
        val later = LocalDate.parse("2026-12-01")
        val atNoon = later.atTime(12, 0)
        assertEquals(Plan(Interval.WEEKS_12, LocalTime.of(19, 0), LocalDate.parse("2027-02-08")), reminders.change(Interval.WEEKS_12, LocalTime.of(19, 0), null, atNoon))
        assertEquals(LocalDateTime.parse("2027-02-08T19:00"), alarm.at)
        assertEquals(LocalDate.parse("2026-12-29"), reminders.change(Interval.WEEKS_4, LocalTime.of(19, 0), null, atNoon).day)
        assertEquals(LocalDate.parse("2027-01-05"), reminders.change(Interval.WEEKS_4, LocalTime.of(19, 0), LocalDate.parse("2027-01-05"), atNoon).day)
    }

    @Test
    fun `changing only the time of a reminder that came already counts from today`() {
        val storage = MemoryStorage()
        val reminders = Reminders(storage, FakeAlarm())
        reminders.turnOn(Interval.WEEKS_4, nine, null, monday)
        assertEquals(LocalDate.parse("2027-01-11"), reminders.change(Interval.WEEKS_4, LocalTime.of(8, 0), null, LocalDateTime.parse("2026-12-14T21:30")).day)
    }

    @Test
    fun `the alarm is set again (the phone restarted) only for a reminder still to come`() {
        val storage = MemoryStorage()
        Reminders(storage, FakeAlarm()).turnOn(Interval.WEEKS_12, nine, null, monday)
        val before = FakeAlarm()
        Reminders(storage, before).rearm(LocalDateTime.parse("2027-02-08T20:59"))
        assertEquals(LocalDateTime.parse("2027-02-08T21:00"), before.at)
        // Once it has been notified, nothing until the next card proof or 一週後再提醒我.
        val after = FakeAlarm()
        val reminders = Reminders(storage, after)
        reminders.rearm(LocalDateTime.parse("2027-02-08T21:00"))
        assertNull(after.at)
        assertTrue(reminders.passed(LocalDateTime.parse("2027-02-08T21:00")))
        assertFalse(reminders.passed(LocalDateTime.parse("2027-02-08T20:59")))
    }
}

/** The phone's storage, in memory. */
internal class MemoryStorage : Storage {
    val values = linkedMapOf<String, String>()

    override fun read(): Map<String, String> = values.toMap()

    override fun write(values: Map<String, String>) {
        this.values.clear()
        this.values.putAll(values)
    }
}

/** An alarm that only notes when it is set for. */
internal class FakeAlarm : Alarm {
    var at: LocalDateTime? = null

    override fun set(at: LocalDateTime) {
        this.at = at
    }

    override fun cancel() {
        at = null
    }
}
