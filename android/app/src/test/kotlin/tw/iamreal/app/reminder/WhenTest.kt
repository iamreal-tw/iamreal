package tw.iamreal.app.reminder

import org.junit.Assert.assertEquals
import org.junit.Test
import tw.iamreal.app.ui.Copy
import java.io.File
import java.time.LocalDate
import java.time.LocalTime

/** The day and the time of a reminder as every screen writes them (design/copy/app.md, "日子和時刻"). */
class WhenTest {
    private val words = When(Copy(File(System.getProperty("iamreal.copy"), "app.json").readText()))

    @Test
    fun `the day is the date and the day of the week`() {
        assertEquals("2027-02-08（星期一）", words.day(LocalDate.parse("2027-02-08")))
        assertEquals("2027-02-14（星期日）", words.day(LocalDate.parse("2027-02-14")))
    }

    @Test
    fun `the time is morning, afternoon or evening, then the hour on a 12-hour clock`() {
        assertEquals("晚上 9:00", words.time(LocalTime.of(21, 0)))
        assertEquals("晚上 6:00", words.time(LocalTime.of(18, 0)))
        assertEquals("下午 5:59", words.time(LocalTime.of(17, 59)))
        assertEquals("下午 12:30", words.time(LocalTime.of(12, 30)))
        assertEquals("上午 11:05", words.time(LocalTime.of(11, 5)))
        assertEquals("上午 12:05", words.time(LocalTime.of(0, 5)))
    }

    @Test
    fun `an interval in short`() {
        assertEquals("三個月", words.interval(Interval.WEEKS_12))
        assertEquals("一個月", words.interval(Interval.WEEKS_4))
        assertEquals("六個月", words.interval(Interval.WEEKS_26))
    }
}
