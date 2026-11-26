package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import tw.iamreal.app.reminder.Interval
import tw.iamreal.app.reminder.Plan
import tw.iamreal.app.reminder.When
import java.io.File
import java.time.LocalDate
import java.time.LocalTime

/** What step 7 says (design/copy/card-proof.md, "7. 提醒"), with the copy's own example. */
class RemindViewTest {
    private val dir = File(System.getProperty("iamreal.copy"))
    private val card = Copy(File(dir, "card-proof.json").readText())
    private val words = When(Copy(File(dir, "app.json").readText()))
    private val today = LocalDate.parse("2026-11-16")
    private val nine = LocalTime.of(21, 0)

    private fun say(plan: Plan?, picked: Boolean = false, denied: Boolean = false, validUntil: String? = null) =
        remindView(card, words, plan, picked, denied, validUntil?.let(LocalDate::parse), today)

    @Test
    fun `nothing stored, the reminder is offered, 12 weeks on at 9 in the evening`() {
        val r = say(null)
        assertEquals(RemindView.Kind.ASK, r.kind)
        assertEquals("提醒我回來過卡", r.title)
        assertEquals(listOf("建議定期更新島民證明，增加說服力。", "這支手機會在 2027-02-08（星期一）晚上 9:00 提醒你，大約三個月後。"), r.lines)
        assertEquals("2027-02-08（星期一）晚上 9:00", r.at)
        assertNull(r.expires)
    }

    @Test
    fun `on, the day it was set again for, about how far off`() {
        val r = say(Plan(Interval.WEEKS_4, LocalTime.of(7, 30), LocalDate.parse("2026-12-14")))
        assertEquals(RemindView.Kind.ON, r.kind)
        assertEquals(listOf("建議定期更新島民證明，增加說服力。", "這支手機會在 2026-12-14（星期一）上午 7:30 提醒你，大約一個月後。"), r.lines)
    }

    @Test
    fun `on with a day picked, not how far off`() {
        val r = say(Plan(Interval.WEEKS_12, nine, LocalDate.parse("2027-01-01")), picked = true)
        assertEquals("這支手機會在 2027-01-01（星期五）晚上 9:00 提醒你。", r.lines[1])
    }

    @Test
    fun `the system did not let the app notify, why there is no reminder and nothing else`() {
        val r = say(null, denied = true, validUntil = "2026-12-01")
        assertEquals(RemindView.Kind.DENIED, r.kind)
        assertEquals("提醒我回來過卡", r.title)
        assertEquals(listOf("沒有排提醒：手機不允許這個 app 發通知。請允許通知設定，我們不會在沒有經過你同意的情況下打擾你。"), r.lines)
        // No reminder: nothing about the certificate ending before it.
        assertNull(r.expires)
    }

    @Test
    fun `a reminder that is on is shown as on, whatever the system said when it was asked before`() {
        assertEquals(RemindView.Kind.ON, say(Plan(Interval.WEEKS_12, nine, LocalDate.parse("2027-02-08")), denied = true).kind)
    }

    @Test
    fun `a certificate that expires before the reminder says so`() {
        assertEquals("這張自然人憑證在 2027-01-15 到期，比下次提醒早。到期之後要展期或換新卡，才能再過卡。", say(null, validUntil = "2027-01-15").expires)
        assertEquals(
            "這張自然人憑證在 2026-12-13 到期，比下次提醒早。到期之後要展期或換新卡，才能再過卡。",
            say(Plan(Interval.WEEKS_4, nine, LocalDate.parse("2026-12-14")), validUntil = "2026-12-13").expires,
        )
    }

    @Test
    fun `a certificate valid on the reminder's day, or one whose date was not read, says nothing`() {
        assertNull(say(null, validUntil = "2027-02-08").expires)
        assertNull(say(null, validUntil = null).expires)
    }
}
