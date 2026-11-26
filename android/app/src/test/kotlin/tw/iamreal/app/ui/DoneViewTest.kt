package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.flow.CardProof.Recorded
import tw.iamreal.app.flow.CardProof.Row
import java.io.File

/**
 * What the steps after the submission say of the server's answer
 * (design/copy/card-proof.md, "6. 掛上去" and "8. 完成和分享"): the sentences
 * are read from design/copy/card-proof.json, and the expected ones are
 * spelled out here as the copy's examples write them.
 */
class DoneViewTest {
    private val copy = Copy(File(System.getProperty("iamreal.copy"), "card-proof.json").readText())
    private val messages = Messages(copy)

    private fun row(platform: String, kind: String, username: String, current: String? = null, previous: String? = null, switchesLeft: Int? = null, known: Boolean = true) =
        Row(platform, known, kind, username, current, previous, switchesLeft)

    private fun done(expected: List<Row>, kinds: List<Recorded>?, mismatches: List<String> = emptyList(), firstRecord: Boolean = false, seq: Long? = 138, ordinal: Long? = if (seq == null) null else 128): CardProof.Done =
        CardProof.Done(
            expected,
            CardProof.Answer(seq, if (seq == null) null else "3f".repeat(32), ordinal, kinds, mismatches),
            firstRecord, "2026-11-16", "7K2Q9FM4XD",
            expected.filter { it.kind != "withdraw" }.map { it.platform to it.username },
            java.time.LocalDate.parse("2031-05-01"),
        )

    private fun lines(row: Messages.DoneRow) = listOf(row.platform, row.username, row.kind, row.expected, row.switchUsed)

    @Test
    fun `a first declaration, recorded as the screen said`() {
        val d = done(listOf(row("threads", "first", "alice")), listOf(Recorded("threads", "first", "alice", 1)), firstRecord = true)
        val view = messages.done(d, "Threads")
        assertEquals("恭喜你完成島民證明", view.title)
        assertNull(view.mismatch)
        assertEquals(copy.say("done.record_single"), view.record)
        assertNull(view.kindsUnreadable)
        assertEquals(listOf(listOf("threads", "alice", copy.say("kinds.first"), null, null)), view.rows.map(::lines))
        // The card's first record: a new card has a new link. Nothing else under the steps.
        assertEquals(listOf("如果你換了新的自然人憑證，請把個人檔案的連結換成新的連結。"), view.notes)
    }

    @Test
    fun `a first declaration, step 6 whole and step 8 with the card's ordinal`() {
        val d = done(listOf(row("threads", "first", "alice")), listOf(Recorded("threads", "first", "alice", 1)), firstRecord = true)
        val view = messages.done(d, "Threads")
        // Step 6, as design/copy/card-proof.md's example writes it (app).
        assertEquals("2026-11-16 記進了證明紀錄。", view.recordedOn)
        assertEquals("把證明掛上你的 Threads 個人檔案", view.hangTitle)
        assertEquals("在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。", view.why)
        assertEquals(listOf(Messages.OpensProfile("打開 Threads", "打開 @alice 的 Threads 個人檔案", "https://www.threads.com/@alice")), view.profiles)
        assertEquals(listOf("按「編輯個人檔案」", "按「連結」", "按「新增連結」", "在「網址」貼上剛才複製的連結，按右上角的「完成」"), view.steps)
        assertEquals("掛好了嗎？打開你的島民證明看看。", view.hung)
        assertEquals(false, view.short)
        assertNull(view.stillThere)
        // Step 8.
        assertEquals("恭喜你完成島民證明", view.title)
        assertEquals(listOf<Pair<String?, String>>(null to "@alice"), view.card)
        assertEquals("這是第 128 張島民證明。", view.ordinal)
        assertEquals(listOf("分享到 Threads"), view.shares)
        assertEquals("我剛剛換了第 128 張島民證明，宣告本帳號背後是一名台灣人。", view.shareText)
        assertEquals(listOf(false, false), listOf(view.withdrawAll, view.showRecord))
    }

    @Test
    fun `a card proof again, step 6 asks only whether the link is still there`() {
        val expected = listOf(row("threads", "refresh", "alice", current = "alice"))
        val view = messages.done(done(expected, listOf(Recorded("threads", "refresh", "alice", 1))), "Threads")
        assertEquals(true, view.short)
        assertEquals("你的 Threads 個人檔案上，還有這個連結嗎？", view.stillThere)
        assertEquals("打開你的島民證明看看。", view.look)
        assertEquals("在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。", view.why)
        assertEquals("島民證明已更新", view.title)
        assertEquals(emptyList<String>(), view.notes)
    }

    @Test
    fun `step 6 is the whole one for anything but a card proof again on one platform, recorded as step 5 said`() {
        val unchanged = listOf(row("threads", "refresh", "alice", current = "alice"))
        val same = listOf(Recorded("threads", "refresh", "alice", 1))
        fun short(d: CardProof.Done, single: String? = "Threads") = messages.done(d, single).let { it.short to it.stillThere }
        val whole = false to null
        // Several platforms.
        assertEquals(whole, short(done(unchanged, same), single = null))
        // The server recorded something else than step 5 said.
        assertEquals(whole, short(done(unchanged, listOf(Recorded("threads", "switch", "alice", 1)), listOf("threads"))))
        // The answer's kinds could not be read.
        assertEquals(whole, short(done(unchanged, null)))
        // A new declaration, a switch, an account declared again after a withdrawal.
        assertEquals(whole, short(done(listOf(row("threads", "first", "alice")), listOf(Recorded("threads", "first", "alice", 1)), firstRecord = true)))
        assertEquals(whole, short(done(listOf(row("threads", "switch", "bob", current = "alice", previous = "alice", switchesLeft = 4)), listOf(Recorded("threads", "switch", "bob", 1)))))
        assertEquals(whole, short(done(listOf(row("threads", "refresh", "alice", current = null)), listOf(Recorded("threads", "refresh", "alice", 1)))))
    }

    @Test
    fun `without an ordinal in the answer, step 8 starts at the invitation`() {
        val expected = listOf(row("threads", "refresh", "alice", current = "alice"))
        assertNull(messages.done(done(expected, listOf(Recorded("threads", "refresh", "alice", 1)), ordinal = null), "Threads").ordinal)
        assertEquals("這是第 1,284 張島民證明。", messages.done(done(expected, listOf(Recorded("threads", "refresh", "alice", 1)), ordinal = 1284), "Threads").ordinal)
    }

    @Test
    fun `the text suggested for sharing, the card's ordinal with a comma every three digits, or the sentence without a number`() {
        val expected = listOf(row("threads", "refresh", "alice", current = "alice"))
        val text = { ordinal: Long? -> messages.done(done(expected, listOf(Recorded("threads", "refresh", "alice", 1)), ordinal = ordinal), "Threads").shareText }
        assertEquals("我剛剛換了第 1 張島民證明，宣告本帳號背後是一名台灣人。", text(1))
        assertEquals("我剛剛換了第 999 張島民證明，宣告本帳號背後是一名台灣人。", text(999))
        assertEquals("我剛剛換了第 1,284 張島民證明，宣告本帳號背後是一名台灣人。", text(1284))
        assertEquals("我剛剛換了第 1,234,567 張島民證明，宣告本帳號背後是一名台灣人。", text(1234567))
        assertEquals("我剛剛換了一張島民證明，宣告本帳號背後是一名台灣人。", text(null))
        // Nothing of the answer told: no ordinal either.
        assertEquals("我剛剛換了一張島民證明，宣告本帳號背後是一名台灣人。", messages.done(done(expected, null, seq = null), "Threads").shareText)
    }

    @Test
    fun `a card that declares on a platform the app does not know too, the names in the small card, and the sentences of several`() {
        val expected = listOf(row("test-example", "refresh", "a-b", current = "a-b", known = false), row("threads", "refresh", "alice", current = "alice"))
        val view = messages.done(done(expected, listOf(Recorded("test-example", "refresh", "a-b", 1), Recorded("threads", "refresh", "alice", 1))), null)
        assertEquals("島民證明已更新", view.title)
        assertEquals(listOf<Pair<String?, String>>("test-example" to "a-b", "Threads" to "@alice"), view.card)
        assertEquals("把證明掛上你的個人檔案", view.hangTitle)
        assertEquals("任何人都能宣告任何帳號。你把同一個連結掛上每個帳號的個人檔案，別人才知道那個帳號承認這張證明。", view.why)
        // No page of an account on a platform the app does not know.
        assertEquals(listOf(Messages.OpensProfile("打開 Threads", "打開 @alice 的 Threads 個人檔案", "https://www.threads.com/@alice")), view.profiles)
        assertEquals(emptyList<String>(), view.notes)
        assertEquals(false, view.short)
    }

    @Test
    fun `every account withdrawn, no card and no hanging, only that the link can be taken down`() {
        val d = done(listOf(row("threads", "withdraw", "alice", current = "alice")), listOf(Recorded("threads", "withdraw", "alice", 0)))
        val view = messages.done(d, "Threads")
        assertEquals("已全部收回", view.title)
        assertEquals(true, view.withdrawAll)
        assertEquals("2026-11-16 記進了證明紀錄。", view.recordedOn)
        assertEquals("你可以拿掉 Threads 個人檔案上的證明連結。", view.unlink)
        // With several platforms, the sentence of an account withdrawn.
        assertEquals("已經收回的帳號，個人檔案上的連結可以拿掉。", messages.done(d, null).unlink)
        // That sentence is step 6's only when the list still has an account: there is no step 6 here.
        assertEquals(emptyList<String>(), view.notes)
        assertEquals(emptyList<Pair<String?, String>>(), view.card)
        assertEquals(emptyList<Messages.OpensProfile>(), view.profiles)
        assertEquals(false, view.showRecord)
    }

    @Test
    fun `the record is shown only where it is not what step 5 said`() {
        val shown = row("threads", "first", "alice")
        assertEquals(false, messages.done(done(listOf(shown), listOf(Recorded("threads", "first", "alice", 1))), "Threads").showRecord)
        assertEquals(true, messages.done(done(listOf(shown), listOf(Recorded("threads", "first", "bob", 1)), listOf("threads")), "Threads").showRecord)
    }

    @Test
    fun `the titles of step 8, by what the server recorded`() {
        fun title(d: CardProof.Done, single: String? = "Threads") = messages.doneTitle(d, single)
        val unchanged = listOf(row("threads", "refresh", "alice", current = "alice"))
        val switched = listOf(row("threads", "switch", "carol.tw", current = "alice", previous = "alice", switchesLeft = 3))
        // The four of the copy's table with one platform: a new declaration, a card proof again, a switch, everything withdrawn.
        assertEquals("恭喜你完成島民證明", title(done(listOf(row("threads", "first", "alice")), listOf(Recorded("threads", "first", "alice", 1)), firstRecord = true)))
        assertEquals("島民證明已更新", title(done(unchanged, listOf(Recorded("threads", "refresh", "alice", 1)))))
        assertEquals("島民證明換成 @carol.tw 了", title(done(switched, listOf(Recorded("threads", "switch", "carol.tw", 1)))))
        assertEquals("已全部收回", title(done(listOf(row("threads", "withdraw", "alice", current = "alice")), listOf(Recorded("threads", "withdraw", "alice", 0)))))
        // Declared again after a withdrawal, and a first declaration on a card with records: congratulated like a first one.
        assertEquals("恭喜你完成島民證明", title(done(listOf(row("threads", "refresh", "alice", current = null)), listOf(Recorded("threads", "refresh", "alice", 1)))))
        assertEquals("恭喜你完成島民證明", title(done(listOf(row("threads", "first", "alice")), listOf(Recorded("threads", "first", "alice", 1)))))
        // An account put there today changed today: named as a switch is.
        assertEquals("島民證明換成 @bob 了", title(done(listOf(row("threads", "correction", "bob", current = "alice", previous = "alice")), listOf(Recorded("threads", "correction", "bob", 1)))))
        // Several platforms: a list that changed is only said to be updated.
        assertEquals("島民證明已更新", title(done(switched, listOf(Recorded("threads", "switch", "carol.tw", 1))), single = null))
        // The server recorded a switch where the screen said nothing changes: not "unchanged", and the account it is now.
        assertEquals("島民證明換成 @alice 了", title(done(unchanged, listOf(Recorded("threads", "switch", "alice", 1)), listOf("threads"))))
        assertEquals("證明紀錄已經記下這次過卡", title(done(unchanged, null)))
        // Nothing of the answer told, on a card's first record: still only that it was recorded.
        assertEquals("證明紀錄已經記下這次過卡", title(done(listOf(row("threads", "first", "alice")), null, firstRecord = true, seq = null)))
    }

    @Test
    fun `kinds the app cannot read, only that the list was recorded`() {
        val view = messages.done(done(listOf(row("threads", "first", "alice")), null), "Threads")
        assertEquals(listOf(null, null), listOf(view.mismatch, view.record))
        assertEquals(copy.say("done.kinds_unreadable"), view.kindsUnreadable)
        assertEquals(0, view.rows.size)
        assertEquals(emptyList<String>(), view.notes)
    }

    @Test
    fun `other cards declare the account too, said once per such account and not of one withdrawn`() {
        val expected = listOf(row("test-example", "withdraw", "a-b", current = "a-b", known = false), row("threads", "refresh", "alice", current = "alice"))
        val view = messages.done(done(expected, listOf(Recorded("test-example", "withdraw", "a-b", 4), Recorded("threads", "refresh", "alice", 2))), null)
        // An account withdrawn and the list not empty: its link can be taken down. Then the other cards.
        assertEquals(listOf("已經收回的帳號，個人檔案上的連結可以拿掉。", copy.say("done.other_cards", "account" to "@alice")), view.notes)
        assertEquals(copy.say("done.record_list"), view.record)
        // One card, or a number the answer does not have: nothing said.
        for (cards in listOf(1L, 0L, null)) {
            assertEquals(emptyList<String>(), messages.done(done(listOf(expected[1]), listOf(Recorded("threads", "refresh", "alice", cards))), "Threads").notes)
        }
    }

    @Test
    fun `a switch recorded where the screen said a correction`() {
        val shown = row("threads", "correction", "bob", current = "alice", previous = "alice")
        val view = messages.done(done(listOf(shown), listOf(Recorded("threads", "switch", "bob", 1)), listOf("threads")), "Threads")
        assertEquals(copy.say("done.mismatch"), view.mismatch)
        assertEquals(
            listOf(
                listOf(
                    "threads", "bob", copy.say("kinds.switch", "previous" to "@alice"),
                    copy.say("done.mismatch_expected", "expected" to copy.say("kinds.switch", "previous" to "@alice") + copy.say("confirm.switch_not_counted")),
                    copy.say("done.mismatch_switch_used"),
                ),
            ),
            view.rows.map(::lines),
        )
    }

    @Test
    fun `another account, a platform more and a platform less`() {
        val expected = listOf(row("test-example", "refresh", "a-b", current = "a-b", known = false), row("threads", "refresh", "alice", current = "alice"))
        val kinds = listOf(Recorded("threads", "refresh", "carol", 1), Recorded("x-new", "switch", "zed", 1))
        val view = messages.done(done(expected, kinds, listOf("test-example", "threads", "x-new")), null)
        assertEquals(copy.say("done.mismatch"), view.mismatch)
        assertEquals(
            listOf(
                // Step 5 showed it, the answer has nothing: no sentence of what was recorded.
                listOf("test-example", "a-b", null, copy.say("done.mismatch_expected", "expected" to copy.say("kinds.unchanged")), null),
                listOf("threads", "carol", copy.say("kinds.again"), copy.say("done.mismatch_expected", "expected" to copy.say("kinds.unchanged")), null),
                // The answer has a platform step 5 did not show: a switch from an account the app does not have.
                listOf("x-new", "zed", null, copy.say("done.mismatch_expected", "expected" to copy.say("done.mismatch_no_platform")), copy.say("done.mismatch_switch_used")),
            ),
            view.rows.map(::lines),
        )
        assertEquals(listOf(false, true, false), view.rows.map { it.known })
    }
}
