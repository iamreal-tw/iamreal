package tw.iamreal.app.reminder

import tw.iamreal.app.ui.Copy
import java.time.LocalDate
import java.time.LocalTime

/** The day and the time of a reminder as every screen writes them (design/copy/app.md, "日子和時刻"), from app.json. */
class When(private val copy: Copy) {
    /** `2027-02-08（星期一）`. */
    fun day(date: LocalDate): String = copy.say("when.day", "date" to date, "weekday" to copy.say("when.${date.dayOfWeek.name.lowercase()}"))

    /** `晚上 9:00`: the part of the day, a space, the hour on a 12-hour clock (0 is 12) and the minutes. */
    fun time(time: LocalTime): String {
        val part = when (time.hour) {
            in 0..11 -> "when.morning"
            in 12..17 -> "when.afternoon"
            else -> "when.evening"
        }
        val hour = (time.hour % 12).let { if (it == 0) 12 else it }
        return "${copy.say(part)} $hour:${time.minute.toString().padStart(2, '0')}"
    }

    /** `三個月`. */
    fun interval(interval: Interval): String = copy.say("interval.${interval.name.lowercase()}")
}
