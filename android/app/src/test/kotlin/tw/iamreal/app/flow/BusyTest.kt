package tw.iamreal.app.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Too many people (ADR-0026; docs/api/card-proof.md, `config` and "Rules for every endpoint"; #419): the card proof against a
 * fake back end on this computer that answers as the Worker does, and turns away the requests a test names with `429`
 * `rate_limited` or `503` `busy`. A card of spec/vectors/ (test keys) is held to the phone, and the core is the library of the
 * tests: a card proof here goes as far as the record sent.
 *
 *   - The start, `config` with the mark (`?start`), turned away: no card is read.
 *   - A `config` without the mark turned away on the way: the card proof goes on with the start's.
 *   - The card's state, the challenge and the submission turned away: each is asked again, and the card is not held to the
 *     phone again for it.
 */
class BusyTest : VectorCardProofTest() {
    @Test
    fun `the start turned away as too many - no card is read`() {
        for ((status, code) in listOf(503 to "busy", 429 to "rate_limited")) {
            val server = server()
            server.away("GET /api/v1/config?start", status, code)
            val card = VectorCard()
            val f = flow(server, card)
            val stop = stopOf { f.begin() }
            assertEquals("$status", "server", stop.code)
            assertEquals("$status", code, stop.values["code"])
            assertTrue("$status: told as too many", stop.tooMany)
            // Nothing more of this card proof: no card read, no other request.
            stopOf { f.readCard(events) }
            assertEquals("$status: the card was held to the phone", 0, card.taps)
            assertEquals("$status", listOf("GET /api/v1/config?start"), server.lines)
        }
    }

    @Test
    fun `the start answered - the reading asks config again without the mark, and the card is read`() {
        val server = server()
        val card = VectorCard()
        val f = flow(server, card)
        f.begin()
        assertTrue(f.readCard(events).name.isNotEmpty())
        assertEquals(1, card.taps)
        // The challenge before the CRL's index (#553).
        assertEquals(listOf("GET /api/v1/config?start", "GET /api/v1/config", "POST /api/v1/challenges", "GET /crl/index.jsonl", "GET /crl/$crlSha256.crl"), server.lines)
        f.cancel()
    }

    @Test
    fun `the reading's config turned away after the start - the card proof goes on with the start's`() {
        for ((status, code) in listOf(429 to "rate_limited", 503 to "busy")) {
            val server = server()
            server.away("GET /api/v1/config", status, code)
            val card = VectorCard()
            val f = flow(server, card)
            f.begin()
            f.readCard(events)
            assertEquals("$status", 1, card.taps)
            assertEquals("$status", listOf("GET /api/v1/config?start", "GET /api/v1/config"), server.lines.take(2))
            f.cancel()
        }
    }

    @Test
    fun `a start answered with what cannot be read is nothing to fall back on`() {
        val server = server()
        server.turnAway.getOrPut("GET /api/v1/config?start") { ConcurrentLinkedQueue() }.add(Answer(200, """{"paused":false}"""))
        server.away("GET /api/v1/config", 429, "rate_limited")
        val card = VectorCard()
        val f = flow(server, card)
        f.begin()
        assertNull(f.startedWith)
        assertTrue(stopOf { f.readCard(events) }.tooMany)
        assertEquals(0, card.taps)
    }

    @Test
    fun `the start had no answer - the card proof goes on, and the reading asks config without the mark`() {
        val server = server()
        // A refusal that is not too many people is no answer to the start: the reading asks again (design/copy/card-proof.md, step 1).
        server.away("GET /api/v1/config?start", 503, "unavailable")
        val card = VectorCard()
        val f = flow(server, card)
        f.begin()
        assertNull(f.startedWith)
        f.readCard(events)
        assertEquals(1, card.taps)
        assertEquals(listOf("GET /api/v1/config?start", "GET /api/v1/config"), server.lines.take(2))
        f.cancel()
    }

    @Test
    fun `a config without the mark turned away on the way - the card proof goes on with the start's`() {
        for ((status, code) in listOf(429 to "rate_limited", 503 to "busy")) {
            val server = server()
            val first = flow(server, VectorCard())
            first.begin()
            first.cancel()
            // 再感應一次卡片: a card proof that does not begin at step 1 asks config without the mark.
            server.away("GET /api/v1/config", status, code)
            val card = VectorCard()
            val f = flow(server, card, first.startedWith)
            f.readCard(events)
            assertEquals("$status", 1, card.taps)
            assertEquals("$status", listOf("GET /api/v1/config?start", "GET /api/v1/config"), server.lines.take(2))
            assertFalse("$status: asked with the mark again", server.lines.drop(1).contains("GET /api/v1/config?start"))
            f.cancel()
        }
    }

    @Test
    fun `a config without the mark turned away, with no start's to go on with - the card proof stops before the card is read`() {
        val server = server()
        server.away("GET /api/v1/config", 429, "rate_limited")
        val card = VectorCard()
        val stop = stopOf { flow(server, card).readCard(events) }
        assertTrue(stop.tooMany)
        assertEquals(0, card.taps)
    }

    /** The bodies of the requests that came as [line]. */
    private fun Server.bodies(line: String) = requests.filter { it.first == line }.map { it.second }

    @Test
    fun `the card's state, the challenge and the submission turned away - each asked again, and the card held to the phone three times in all`() {
        val server = server()
        val card = VectorCard()
        var clock = now
        val f = flow(server, card, clock = { clock })
        f.begin()
        // The reading's config turned away too: the card proof goes on with the start's, and goes through.
        server.away("GET /api/v1/config", 429, "rate_limited")
        f.readCard(events)
        // The PIN comes 5 minutes after the reading: the challenge asked for then is too old, and declare() asks for its own.
        clock += CardProof.HELD_CHALLENGE_MS
        // Nothing to ask again before something was turned away.
        assertEquals("state", stopOf { f.retryCardState() }.code)

        // Tap 2: the card signs, and the server turns the card's state away. The card proof does not end.
        server.away("POST /api/v1/card-state", 503, "busy")
        val turned = stopOf { f.confirmCard("123456".toByteArray(), events) }
        assertTrue(turned.tooMany)
        assertEquals("busy", turned.values["code"])
        assertEquals("0123456789abcdef", turned.requestId)
        assertEquals(2, card.taps)
        // 再試一次: the same request, the card not held to the phone again.
        val status = f.retryCardState()
        assertEquals(2, card.taps)
        assertEquals(1, card.pinsHanded)
        val states = server.bodies("POST /api/v1/card-state")
        assertEquals(2, states.size)
        assertEquals(states[0], states[1])
        assertEquals(null, status.lastCardProof)
        assertEquals("state", stopOf { f.retryCardState() }.code)

        f.choose(mapOf("threads" to "alice"))
        // The challenge turned away: before tap 3, the PIN kept. The button again asks for a challenge, then tap 3.
        server.away("POST /api/v1/challenges", 429, "rate_limited")
        val noChallenge = stopOf { f.declare(events) }
        assertTrue(noChallenge.tooMany)
        assertNull(noChallenge.values["submitting"])
        assertEquals(2, card.taps)
        assertEquals("state", stopOf { f.resubmit() }.code)

        // Tap 3, the proof, and the submission turned away.
        server.away("POST /api/v1/records", 503, "busy")
        val notSent = stopOf { f.declare(events) }
        assertTrue(notSent.tooMany)
        assertEquals("true", notSent.values["submitting"])
        assertEquals(3, card.taps)
        assertEquals(2, card.pinsHanded)
        // The reading's, the one turned away, and the one the card signed.
        assertEquals(3, server.bodies("POST /api/v1/challenges").size)

        // 再試一次: the same record sent again, nothing signed or computed again.
        val done = f.resubmit()
        assertEquals(3, card.taps)
        assertEquals(2, card.pinsHanded)
        val records = server.bodies("POST /api/v1/records")
        assertEquals(2, records.size)
        assertEquals(records[0], records[1])
        assertEquals(declared.getString("challenge").substring(0, 10), done.date)
        assertEquals(listOf("threads" to "alice"), done.accounts)
        // The card proof is over.
        assertEquals("state", stopOf { f.resubmit() }.code)

        // The counts of the whole card proof (#433): every step of the app's once (the tree's and the files' come from the
        // background, in any order with the PIN's), the three that were turned away as retries, the record sent again as an
        // action, the three durations, and no stop: the card proof went through.
        val said = recorded.events()
        val steps = said.filter { it.startsWith("step:") }
        assertEquals(steps.toSet().size, steps.size)
        assertEquals(
            setOf("read", "config", "certificates", "certificate", "crl", "tree", "circuit", "engine", "checked", "pin", "scope_signed", "state", "chosen", "confirmed", "challenge", "code_signed", "proved", "done").map { "step:$it" }.toSet(),
            steps.toSet(),
        )
        assertEquals("step:read", steps.first())
        assertEquals("step:done", steps.last())
        assertEquals(listOf("retry:server_busy", "retry:server_rate_limited", "retry:server_busy"), said.filter { it.startsWith("retry:") })
        assertEquals(listOf("action:resubmit"), said.filter { it.startsWith("action:") })
        assertEquals(setOf("crl", "tree", "proved"), said.filter { it.startsWith("duration:") }.map { it.split(":")[1] }.toSet())
        assertTrue(said.none { it.startsWith("stop:") })
        // Each count is the core's body for an app: no account, no short ID, nothing of the card.
        for (count in recorded.sent) {
            assertEquals("android", count.getString("client"))
            assertFalse(count.toString().contains("alice"))
        }
        // The submission carried the card proof device ID of the counts, both times.
        val ids = records.map { org.json.JSONObject(it).getString("device_id") }.toSet()
        assertEquals(setOf(recorded.counts.deviceId()), ids)
    }
}
