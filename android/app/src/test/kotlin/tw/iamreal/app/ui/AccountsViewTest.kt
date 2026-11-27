package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.iamreal.app.flow.CardProof.Slot
import tw.iamreal.app.flow.CardProof.Status
import java.io.File

/**
 * What step 4 says of the card's status (design/copy/card-proof.md, "4. 你的帳號"): which of its screens, and
 * the sentences of each, spelled out here as the copy's examples write them.
 */
class AccountsViewTest {
    private val copy = Copy(File(System.getProperty("iamreal.copy"), "card-proof.json").readText())
    private val messages = Messages(copy)

    private fun slot(platform: String, current: String?, lastDeclared: String? = current, switchCount: Int = 0, known: Boolean = true) =
        Slot(platform, known, current, lastDeclared, switchCount, 5 - switchCount)

    private fun status(vararg slots: Slot, daysSince: Int? = null, dailyLimit: Boolean = false, table: List<String> = listOf("threads")) =
        Status("7K2Q9FM4XD", daysSince?.let { "2026-11-04" }, daysSince, slots.toList(), table, dailyLimit, "2026-11-16")

    /** Under the field of a row never declared: with the switches a typo costs. */
    private val preview = "請預覽你的 Threads 個人檔案，避免打錯帳號。一張卡終身最多只能更換 5 次。"

    /** Where the screen already says how many switches are left. */
    private val previewCounted = "請預覽你的 Threads 個人檔案，避免打錯帳號。"

    @Test
    fun `a card that never declared, only the field to fill`() {
        val view = messages.accountsView(status(slot("threads", null))) as Messages.FillView
        assertEquals("你的 Threads 帳號", view.title)
        assertEquals(listOf("這張卡片還沒有宣告過帳號。", "填上你要宣告的 Threads 帳號。"), view.lead)
        assertEquals(listOf("threads"), view.rows.map { it.platform })
        val row = view.rows[0]
        assertEquals(listOf("Threads", "@", "", true), listOf(row.name, row.prefix, row.current, row.editable))
        // One platform, never declared: nothing under the row, and no rule of switching.
        assertEquals(emptyList<String>(), row.lines)
        assertEquals(listOf(preview), view.notes)
        assertNull(view.dailyLimit)
        assertEquals(false, view.editList)
    }

    @Test
    fun `a card that withdrew everything, the field again and what the row was`() {
        val view = messages.accountsView(status(slot("threads", null, lastDeclared = "bob", switchCount = 1), daysSince = 12)) as Messages.FillView
        assertEquals(listOf("這張卡片目前沒有宣告任何帳號。", "填上你要宣告的 Threads 帳號。"), view.lead)
        assertEquals(listOf("上一次宣告的是 @bob，已經收回。填回 @bob 不算更換。", "更換過 1 次，還可以更換 4 次。"), view.rows[0].lines)
        assertEquals(listOf(previewCounted), view.notes)
    }

    @Test
    fun `a card that declares an account, the account, when it last did, and the three actions`() {
        val view = messages.accountsView(status(slot("threads", "alice"), daysSince = 87)) as Messages.DeclaredView
        assertEquals("你的 Threads 帳號", view.title)
        assertEquals("這張卡片目前宣告：", view.declaredNow)
        assertEquals(listOf(Triple("threads", null, "@alice")), view.current.map { Triple(it.platform, it.name, it.account) })
        assertEquals("上次過卡是 87 天前", view.last)
        assertEquals("更新島民證明", view.refresh)
        assertEquals("宣告帳號不變，把島民證明上的日期更新成今天。", view.refreshNote)
        assertEquals("改成別的帳號", view.switchAccount)
        assertEquals("收回對 @alice 的宣告", view.withdraw)
        assertNull(view.editList)
        assertNull(view.dailyLimit)
    }

    @Test
    fun `the last card proof the same day is today, not 0 days ago`() {
        val view = messages.accountsView(status(slot("threads", "alice"), daysSince = 0)) as Messages.DeclaredView
        assertEquals("上次過卡是今天", view.last)
    }

    @Test
    fun `3 records today, the account as it is and nothing to press but back to the beginning`() {
        val view = messages.accountsView(status(slot("threads", "alice"), daysSince = 0, dailyLimit = true)) as Messages.DeclaredView
        assertEquals(listOf("@alice"), view.current.map { it.account })
        assertEquals("上次過卡是今天", view.last)
        assertEquals("這張卡片今天已經過卡 3 次，明天才能再過卡。", view.dailyLimit)
        assertEquals(listOf<String?>(null, null, null), listOf(view.switchAccount, view.withdraw, view.editList))
    }

    @Test
    fun `3 records today, the whole of step 6 for the account declared now, with no record of today`() {
        val view = messages.hangFromLimit(status(slot("threads", "alice"), daysSince = 0, dailyLimit = true), "Threads")
        assertEquals("把證明掛上你的 Threads 個人檔案", view.title)
        assertEquals("在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。", view.why)
        assertEquals(listOf(Messages.OpensProfile("打開 Threads", "打開 @alice 的 Threads 個人檔案", "https://www.threads.com/@alice")), view.profiles)
        assertEquals(listOf("按「編輯個人檔案」", "按「連結」", "按「新增連結」", "在「網址」貼上剛才複製的連結，按右上角的「完成」"), view.steps)
        assertEquals("掛好了嗎？打開你的島民證明看看。", view.hung)
        assertEquals("@alice", view.account)
        // An account on a platform the app does not know: no button for its profile, and not the one the demonstration draws.
        val other = messages.hangFromLimit(status(slot("example", "a-b", known = false), slot("threads", "alice"), daysSince = 0, dailyLimit = true, table = listOf("example", "threads")), null)
        assertEquals(listOf("https://www.threads.com/@alice"), other.profiles.map { it.address })
        assertEquals("@alice", other.account)
    }

    @Test
    fun `3 records today, 重新掛上連結 only for an account the app can hang`() {
        assertTrue(messages.canHangFromLimit(status(slot("threads", "alice"), daysSince = 0, dailyLimit = true)))
        // Everything withdrawn today: nothing to hang.
        assertEquals(false, messages.canHangFromLimit(status(slot("threads", null, lastDeclared = "alice"), daysSince = 0, dailyLimit = true)))
        // Only an account on a platform the app does not know: no profile to open, no demonstration.
        assertEquals(false, messages.canHangFromLimit(status(slot("example", "a-b", known = false), slot("threads", null), daysSince = 0, dailyLimit = true, table = listOf("example", "threads"))))
    }

    @Test
    fun `3 records today and nothing declared, the row as it is`() {
        val view = messages.accountsView(status(slot("threads", null, lastDeclared = "alice"), daysSince = 0, dailyLimit = true)) as Messages.FillView
        assertEquals("這張卡片今天已經過卡 3 次，明天才能再過卡。", view.dailyLimit)
        assertEquals(false, view.rows[0].editable)
        assertEquals(emptyList<String>(), view.rows[0].lines)
        assertEquals(emptyList<String>(), view.notes)
    }

    @Test
    fun `another account, what it does and how many switches are left after it`() {
        val view = messages.switchView(status(slot("threads", "alice", switchCount = 1), daysSince = 87))
        assertEquals("你的 Threads 帳號", view.title)
        assertEquals("這張卡片目前宣告 @alice。", view.intro)
        assertEquals("改成別的帳號", view.heading)
        // The field starts empty: the account is typed, not edited.
        assertEquals(listOf("threads", "", true), view.row!!.let { listOf(it.platform, it.current, it.editable) })
        assertEquals(emptyList<String>(), view.row!!.lines)
        assertEquals("改了之後，@alice 不再是這張卡片宣告的帳號。一張卡終身最多更換 5 次，這次之後還可以更換 3 次。", view.cost)
        assertEquals(previewCounted, view.previewNote)
        assertEquals("不改了", view.keep)
    }

    @Test
    fun `another account, the last switch`() {
        val view = messages.switchView(status(slot("threads", "alice", switchCount = 4), daysSince = 87))
        assertEquals("改了之後，@alice 不再是這張卡片宣告的帳號。用掉最後一次更換。這次之後，這個平台不能再更換。", view.cost)
    }

    @Test
    fun `no switch left, no field`() {
        val view = messages.switchView(status(slot("threads", "alice", switchCount = 5), daysSince = 87))
        assertEquals("這張卡片目前宣告 @alice。", view.intro)
        assertNull(view.row)
        assertNull(view.heading)
        assertEquals("已經更換 5 次，這個平台不能再更換。", view.cost)
        assertNull(view.previewNote)
        assertEquals("不改了", view.keep)
    }

    @Test
    fun `the search handed to the map app is for the words of the copy, and nothing else goes with it`() {
        val office = java.net.URLEncoder.encode("戶政事務所", "UTF-8")
        // design/copy/card-proof.md, "1. 開始之前": the map app searches for 戶政事務所; no place is given, what is near is the map's to tell.
        assertTrue(File(System.getProperty("iamreal.copy"), "card-proof.md").readText().contains("搜尋「戶政事務所」"))
        assertEquals("geo:0,0?q=$office", FIND_OFFICE_MAP)
        assertEquals("https://www.google.com/maps/search/?api=1&query=$office", FIND_OFFICE_SITE)
    }

    // The server's table with a platform the app does not know, where the card has an account: the screens of several platforms.

    private val two = arrayOf(slot("test-example", "alice-b", known = false), slot("threads", "alice", switchCount = 1))

    @Test
    fun `accounts on several platforms, one button to change the list in place of the two`() {
        val view = messages.accountsView(status(*two, daysSince = 12)) as Messages.DeclaredView
        assertEquals("你的帳號", view.title)
        assertEquals(listOf(Triple("test-example", "test-example", "alice-b"), Triple("threads", "Threads", "@alice")), view.current.map { Triple(it.platform, it.name, it.account) })
        assertEquals("上次過卡是 12 天前", view.last)
        assertEquals("更新島民證明", view.refresh)
        assertEquals(listOf(null, null, "修改帳號清單"), listOf(view.switchAccount, view.withdraw, view.editList))
    }

    @Test
    fun `the list to change, a row for each platform`() {
        val view = messages.editListView(status(*two, daysSince = 12))
        assertEquals("你的帳號", view.title)
        assertEquals(listOf("這是這張卡片目前宣告的帳號。"), view.lead)
        assertEquals(true, view.editList)
        val (other, threads) = view.rows
        // Kept as the server sent it: no field, no prefix, no preview.
        assertEquals(listOf("test-example", "", "alice-b", false), listOf(other.name, other.prefix, other.current, other.editable))
        assertEquals(listOf("Threads", "@", "alice", true), listOf(threads.name, threads.prefix, threads.current, threads.editable))
        assertEquals(listOf("更換過 1 次，還可以更換 4 次。"), threads.lines)
        assertEquals(listOf("填上空白的是新宣告，清空是收回，改成別的帳號是更換。一張卡終身最多只能更換宣告的帳號 5 次。", previewCounted), view.notes)
    }

    @Test
    fun `several platforms and nothing declared, the rules of the list under it`() {
        val never = messages.accountsView(status(slot("threads", null), table = listOf("threads", "x"))) as Messages.FillView
        assertEquals("你的帳號", never.title)
        assertEquals(listOf("這張卡片還沒有宣告過帳號。", "填上你要宣告的帳號，至少一個。沒有要宣告的平台留空白。"), never.lead)
        assertEquals(listOf("還沒有宣告過。"), never.rows[0].lines)
        assertEquals("一張卡片在每個平台只能宣告一個帳號，之後改成別的帳號是更換。一張卡終身最多只能更換宣告的帳號 5 次。", never.notes[0])
        val nothing = messages.accountsView(status(slot("threads", null, lastDeclared = "bob"), daysSince = 3, table = listOf("threads", "x"))) as Messages.FillView
        assertEquals("填上空白的是新宣告，清空是收回，改成別的帳號是更換。一張卡終身最多只能更換宣告的帳號 5 次。", nothing.notes[0])
    }
}
