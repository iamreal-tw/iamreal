package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import tw.iamreal.app.flow.CardProof.Consequence
import tw.iamreal.app.flow.CardProof.Row
import tw.iamreal.app.flow.CardProof.Slot
import tw.iamreal.app.flow.CardProof.Status
import java.io.File

/**
 * What step 5 says of the list to be signed (design/copy/card-proof.md, "5. 確認"): its first sentence, the
 * points under the list and the button, spelled out here as the copy's examples write them.
 */
class ConfirmViewTest {
    private val copy = Copy(File(System.getProperty("iamreal.copy"), "card-proof.json").readText())
    private val messages = Messages(copy)

    private fun row(platform: String, kind: String, username: String, current: String? = null, previous: String? = null, switchesLeft: Int? = null, known: Boolean = true) =
        Row(platform, known, kind, username, current, previous, switchesLeft)

    private fun list(vararg rows: Row) =
        Consequence(rows.filter { it.kind != "withdraw" }.map { it.platform to it.username }, rows.toList(), false, "2026-11-16", ByteArray(0))

    private val one = Status("7K2Q9FM4XD", "2026-11-04", 12, listOf(Slot("threads", true, "alice", "alice", 0, 5, false)), listOf("threads"), false, "2026-11-16")
    private val several = Status(
        "7K2Q9FM4XD", "2026-11-04", 12,
        listOf(Slot("test-example", false, "alice-b", "alice-b", 0, 5, false), Slot("threads", true, "alice", "alice", 0, 5, false)),
        listOf("threads"), false, "2026-11-16",
    )

    private val notIdentifiable = "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。"
    private val holderLater = "任何持有這張卡片和 PIN 的人，都能查詢、更新、收回或更換這張證明宣告的 Threads 帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。"

    private fun points(view: Messages.ConfirmView) = view.points.map { it.text to it.strong }

    @Test
    fun `a card proof again, the two points and the words of step 4's button`() {
        val view = messages.confirmView(list(row("threads", "refresh", "alice", current = "alice")), one)
        assertEquals("按下後，證明紀錄會記下新的證明並公開給所有人：", view.intro)
        // The words that no record can be deleted are the ones in bold.
        assertEquals(listOf(notIdentifiable to null, holderLater to "所有紀錄公開後無法刪除"), points(view))
        assertEquals("更新島民證明", view.button)
        assertNull(view.withdrawStays)
        assertNull(view.listedTogether)
    }

    @Test
    fun `a first declaration and a switch, the same sentences and the button that declares`() {
        for (rows in listOf(row("threads", "first", "alice"), row("threads", "switch", "carol.tw", current = "alice", previous = "alice", switchesLeft = 3))) {
            val view = messages.confirmView(list(rows), one)
            assertEquals("按下後，證明紀錄會記下新的證明並公開給所有人：", view.intro)
            assertEquals(listOf(notIdentifiable to null, holderLater to "所有紀錄公開後無法刪除"), points(view))
            assertEquals("宣告這個帳號", view.button)
        }
    }

    @Test
    fun `the account withdrawn, three points and the button that names it`() {
        val view = messages.confirmView(list(row("threads", "withdraw", "alice", current = "alice")), one)
        assertEquals("按下後，證明紀錄會公開記下這張卡片不再宣告任何帳號：", view.intro)
        assertEquals(
            listOf<Pair<String, String?>>("歷史證明紀錄無法刪除，依然看得出這張卡片過去曾宣告過的帳號。" to null, notIdentifiable to null, "任何持有這張卡片和 PIN 的人，都能查詢或再宣告。" to null),
            points(view),
        )
        assertEquals("收回對 @alice 的宣告", view.button)
        assertNull(view.withdrawStays)
        assertNull(view.listedTogether)
    }

    @Test
    fun `several platforms, the list's own sentences`() {
        val kept = row("test-example", "refresh", "alice-b", current = "alice-b", known = false)
        val changed = messages.confirmView(list(kept, row("threads", "withdraw", "alice", current = "alice")), several)
        assertEquals("按下後，證明紀錄會公開記下這張卡片的帳號清單：", changed.intro)
        assertEquals("收回之後，證明紀錄裡原本的紀錄還在：看得出這張卡片宣告過這個帳號。", changed.withdrawStays)
        assertEquals("這些帳號會公開列在同一張島民證明上。確認裡面沒有你不想被認出來的帳號。", changed.listedTogether)
        assertEquals(listOf(notIdentifiable to null, holderLater to "所有紀錄公開後無法刪除"), points(changed))
        assertEquals("宣告這份清單", changed.button)

        val same = messages.confirmView(list(kept, row("threads", "refresh", "alice", current = "alice")), several)
        assertEquals("更新島民證明", same.button)
        assertNull(same.withdrawStays)
    }
}
