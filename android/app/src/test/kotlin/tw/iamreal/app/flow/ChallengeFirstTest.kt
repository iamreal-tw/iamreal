package tw.iamreal.app.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.CardException
import tw.iamreal.app.card.TapCancel

/**
 * The challenge is asked for before the CRL's index (#553): the server takes the root of the second newest CRL only for a
 * challenge issued before it learned of the newest, or at most 2 minutes after (spec/revocation-tree.md, "Who checks what").
 * declare() has the card sign that challenge if tap 2 came within [CardProof.HELD_CHALLENGE_MS] of asking for it and the date
 * in Taiwan is the same, and asks for a new one otherwise. As on the web page (web/test/flow.test.ts, "the challenge, asked for before the CRL").
 */
class ChallengeFirstTest : VectorCardProofFixture() {
    private val challenges = "POST /api/v1/challenges"

    /** Tap 2 and the list: @alice on Threads. */
    private fun toChosen(f: CardProof) {
        f.confirmCard("123456".toByteArray(), events)
        f.choose(mapOf("threads" to "alice"))
    }

    @Test
    fun `the challenge is asked for after the server's config, before the CRL's index`() {
        val server = server()
        val f = flow(server, VectorCard())
        f.readCard(events)
        assertEquals(listOf("GET /api/v1/config", challenges, "GET /crl/index.jsonl", "GET /crl/$crlSha256.crl"), server.lines)
        f.cancel()
    }

    @Test
    fun `the CRL changes after the phone downloaded it - the card signs the challenge of before, and the record is taken`() {
        val server = server()
        var changed = false
        var issuedAfterChange = false
        // Like the Worker's, the server takes the root the phone has, now the second newest, only for a challenge issued before
        // the change (the 2 minutes after it are past here); otherwise `root`. Every challenge it issues is the vectors' one, so
        // the record's is taken as the last one issued.
        server.answers = { request, _ ->
            when (request) {
                challenges -> {
                    issuedAfterChange = changed
                    null
                }
                "POST /api/v1/records" -> if (issuedAfterChange) Answer(400, """{"error":"root"}""") else null
                else -> null
            }
        }
        var clock = now
        val f = flow(server, VectorCard(), clock = { clock })
        f.readCard(events)
        // The mirror hands the server a newer CRL, and the cardholder takes 2 minutes over the PIN and one more over the list.
        changed = true
        clock += 2 * 60_000
        toChosen(f)
        clock += 60_000
        val done = f.declare(events)
        assertEquals(listOf("threads" to "alice"), done.accounts)
        assertEquals(1, server.lines.count { it == challenges })
    }

    @Test
    fun `tap 2 just under HELD_CHALLENGE_MS after it was asked for - the same challenge, and at it or with the clock gone back a new one`() {
        for ((after, requests) in listOf(CardProof.HELD_CHALLENGE_MS - 1 to 1, CardProof.HELD_CHALLENGE_MS to 2, -1L to 2)) {
            val server = server()
            var clock = now
            val f = flow(server, VectorCard(), clock = { clock })
            f.readCard(events)
            clock += after
            toChosen(f)
            f.declare(events)
            assertEquals("$after", requests, server.lines.count { it == challenges })
        }
    }

    @Test
    fun `tap 2 in time, tap 3 almost 5 minutes after it - still the reading's challenge`() {
        val server = server()
        var clock = now
        val f = flow(server, VectorCard(), clock = { clock })
        f.readCard(events)
        clock += CardProof.HELD_CHALLENGE_MS - 1
        toChosen(f)
        clock += CardProof.IDLE_MS - 1
        f.declare(events)
        assertEquals(1, server.lines.count { it == challenges })
    }

    @Test
    fun `the last tap made again - the reading's challenge again`() {
        val server = server()
        val card = object : Card {
            val inner = VectorCard()
            var left = false

            override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T {
                // At the third tap, once, no card came.
                if (inner.taps == 2 && !left) {
                    left = true
                    throw CardException(CardException.Reason.NO_TAP)
                }
                return inner.tap(cancel, use)
            }
        }
        val f = flow(server, card)
        f.readCard(events)
        toChosen(f)
        assertEquals("card", stopOf { f.declare(events) }.code)
        f.declare(events)
        assertEquals(3, card.inner.taps)
        assertEquals(1, server.lines.count { it == challenges })
    }

    @Test
    fun `the reading's challenge turned away - the card proof goes on, nothing of it is counted, and declare asks for one`() {
        for ((status, code) in listOf(429 to "rate_limited", 503 to "busy", 503 to "paused", 500 to "internal")) {
            val server = server()
            server.away(challenges, status, code)
            val card = VectorCard()
            val f = flow(server, card)
            f.readCard(events)
            toChosen(f)
            val done = f.declare(events)
            assertEquals("$status $code", listOf("threads" to "alice"), done.accounts)
            assertEquals("$status $code", 2, server.lines.count { it == challenges })
            assertEquals("$status $code", 3, card.taps)
        }
        val said = recorded.events()
        assertTrue(said.toString(), said.none { it.startsWith("retry:") || it.startsWith("stop:") })
    }

    @Test
    fun `midnight between the reading and declare - a challenge of the new day is asked for`() {
        val server = server()
        // Read at 23:57 in Taiwan on the vectors' day, tap 2 at 23:59, declare() at 00:01 the day after.
        var clock = now + 11 * 3_600_000 + 57 * 60_000
        val f = flow(server, VectorCard(), clock = { clock })
        f.readCard(events)
        clock += 2 * 60_000
        toChosen(f)
        clock += 2 * 60_000
        // The vectors' challenge is of the day before, so the new one stops too: what this looks at is that it was asked for.
        assertEquals("date_mismatch", stopOf { f.declare(events) }.code)
        assertEquals(2, server.lines.count { it == challenges })
    }
}
