package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.flow.CardProof.Recorded
import tw.iamreal.app.flow.CardProof.Row
import java.io.File

/**
 * What step 6 says of the server's answer (design/copy/card-proof.md,
 * "完成"): the sentences are read from design/copy/card-proof.json, and the
 * expected ones are spelled out here from the same file's keys.
 */
class DoneViewTest {
    private val copy = Copy(File(System.getProperty("iamreal.copy"), "card-proof.json").readText())
    private val messages = Messages(copy)

    private fun row(platform: String, kind: String, username: String, current: String? = null, previous: String? = null, switchesLeft: Int? = null, known: Boolean = true) =
        Row(platform, known, kind, username, current, previous, switchesLeft)

    private fun done(expected: List<Row>, kinds: List<Recorded>?, mismatches: List<String> = emptyList(), firstRecord: Boolean = false, seq: Long? = 138): CardProof.Done =
        CardProof.Done(
            expected,
            CardProof.Answer(seq, if (seq == null) null else "3f".repeat(32), kinds, mismatches),
            firstRecord, "2026-11-16", "7K2Q9FM4XD",
            expected.filter { it.kind != "withdraw" }.map { it.platform to it.username },
            "2031-05-01",
        )

    private fun lines(row: Messages.DoneRow) = listOf(row.platform, row.username, row.kind, row.expected, row.switchUsed)

    @Test
    fun `a first declaration, recorded as the screen said`() {
        val d = done(listOf(row("threads", "first", "alice")), listOf(Recorded("threads", "first", "alice", 1)), firstRecord = true)
        val view = messages.done(d, "Threads")
        assertEquals(copy.say("done.first"), messages.doneTitle(d))
        assertNull(view.mismatch)
        assertEquals(copy.say("done.record_single"), view.record)
        assertNull(view.kindsUnreadable)
        assertEquals(listOf(listOf("threads", "alice", copy.say("kinds.first"), null, null)), view.rows.map(::lines))
        assertEquals(emptyList<String>(), view.otherCards)
        assertEquals(false, view.withdrawnLink)
    }

    @Test
    fun `a first declaration, the small card, the hanging on the profile and what can be done besides`() {
        val d = done(listOf(row("threads", "first", "alice")), listOf(Recorded("threads", "first", "alice", 1)), firstRecord = true)
        val view = messages.done(d, "Threads")
        // The sentences as design/copy/card-proof.md's example of step 6 writes them.
        assertEquals("你拿到島民證明了", view.title)
        assertEquals(listOf<Pair<String?, String>>(null to "@alice"), view.card)
        assertEquals("2026-11-16 記進了證明紀錄。", view.recordedOn)
        assertEquals("最後一步：掛到你的 Threads 個人檔案", view.hangTitle)
        assertEquals("任何人都能宣告任何帳號。你把連結掛上個人檔案，別人才知道這個帳號承認這張證明。", view.anyone)
        assertEquals(listOf("打開 @alice 的 Threads 個人檔案" to "https://www.threads.com/@alice"), view.profiles)
        assertEquals(listOf("把你的島民證明分享到 Threads。" to "分享"), view.shares)
        assertEquals("掛好了嗎？打開你的島民證明看看。", view.hung)
        assertEquals(listOf(false, true, false, false), listOf(view.withdrawAll, view.newCard, view.withdrawnLink, view.showRecord))
    }

    @Test
    fun `a card that declares on a platform the app does not know too, the names in the small card, and the sentences of several`() {
        val expected = listOf(row("test-example", "refresh", "a-b", current = "a-b", known = false), row("threads", "refresh", "alice", current = "alice"))
        val view = messages.done(done(expected, listOf(Recorded("test-example", "refresh", "a-b", 1), Recorded("threads", "refresh", "alice", 1))), null)
        assertEquals("島民證明已更新", view.title)
        assertEquals(listOf<Pair<String?, String>>("test-example" to "a-b", "Threads" to "@alice"), view.card)
        assertEquals("最後一步：掛到你的個人檔案", view.hangTitle)
        assertEquals(copy.say("done.anyone"), view.anyone)
        // No page of an account on a platform the app does not know.
        assertEquals(listOf("打開 @alice 的 Threads 個人檔案" to "https://www.threads.com/@alice"), view.profiles)
        assertEquals(false, view.newCard)
    }

    @Test
    fun `every account withdrawn, no card and no hanging, only that the links can be taken down`() {
        val view = messages.done(done(listOf(row("threads", "withdraw", "alice", current = "alice")), listOf(Recorded("threads", "withdraw", "alice", 0))), "Threads")
        assertEquals("已全部收回", view.title)
        assertEquals(listOf(true, true), listOf(view.withdrawAll, view.withdrawnLink))
        assertEquals(emptyList<Pair<String?, String>>(), view.card)
        assertEquals(emptyList<Pair<String, String>>(), view.profiles)
        assertEquals(false, view.showRecord)
    }

    @Test
    fun `the record is shown only where it is not what step 5 said`() {
        val shown = row("threads", "first", "alice")
        assertEquals(false, messages.done(done(listOf(shown), listOf(Recorded("threads", "first", "alice", 1))), "Threads").showRecord)
        assertEquals(true, messages.done(done(listOf(shown), listOf(Recorded("threads", "first", "bob", 1)), listOf("threads")), "Threads").showRecord)
    }

    @Test
    fun `the titles, by what the server recorded`() {
        val unchanged = listOf(row("threads", "refresh", "alice", current = "alice"))
        assertEquals(copy.say("done.refresh"), messages.doneTitle(done(unchanged, listOf(Recorded("threads", "refresh", "alice", 1)))))
        // The server recorded a switch where the screen said nothing changes: not "unchanged".
        assertEquals(copy.say("done.changed"), messages.doneTitle(done(unchanged, listOf(Recorded("threads", "switch", "alice", 1)), listOf("threads"))))
        assertEquals(copy.say("done.withdraw_all"), messages.doneTitle(done(listOf(row("threads", "withdraw", "alice", current = "alice")), listOf(Recorded("threads", "withdraw", "alice", 0)))))
        assertEquals(copy.say("done.recorded_only"), messages.doneTitle(done(unchanged, null)))
        // Nothing of the answer told, on a card's first record: still only that it was recorded.
        assertEquals(copy.say("done.recorded_only"), messages.doneTitle(done(listOf(row("threads", "first", "alice")), null, firstRecord = true, seq = null)))
    }

    @Test
    fun `kinds the app cannot read, only that the list was recorded`() {
        val view = messages.done(done(listOf(row("threads", "first", "alice")), null), "Threads")
        assertEquals(listOf(null, null), listOf(view.mismatch, view.record))
        assertEquals(copy.say("done.kinds_unreadable"), view.kindsUnreadable)
        assertEquals(0, view.rows.size)
        assertEquals(emptyList<String>(), view.otherCards)
    }

    @Test
    fun `other cards declare the account too, said once per such account and not of one withdrawn`() {
        val expected = listOf(row("test-example", "withdraw", "a-b", current = "a-b", known = false), row("threads", "refresh", "alice", current = "alice"))
        val view = messages.done(done(expected, listOf(Recorded("test-example", "withdraw", "a-b", 4), Recorded("threads", "refresh", "alice", 2))), null)
        assertEquals(listOf(copy.say("done.other_cards", "account" to "@alice")), view.otherCards)
        assertEquals(copy.say("done.record_list"), view.record)
        assertEquals(true, view.withdrawnLink)
        // One card, or a number the answer does not have: nothing said.
        for (cards in listOf(1L, 0L, null)) {
            assertEquals(emptyList<String>(), messages.done(done(listOf(expected[1]), listOf(Recorded("threads", "refresh", "alice", cards))), "Threads").otherCards)
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
