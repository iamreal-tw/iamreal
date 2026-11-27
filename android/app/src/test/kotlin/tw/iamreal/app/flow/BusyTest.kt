package tw.iamreal.app.flow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import tw.iamreal.app.backend.Backend
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.TapCancel
import tw.iamreal.app.core.DeviceCore
import tw.iamreal.app.core.TestingCore
import java.io.BufferedInputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

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
class BusyTest {
    private fun vectors(name: String) = JSONObject(File(System.getProperty("iamreal.vectors"), name).readText())

    private fun bundled(name: String): ByteArray = System.getProperty("iamreal.bundled").split(File.pathSeparator)
        .map { File(it, name) }.first { it.isFile }.readBytes()

    private fun unhex(s: String): ByteArray = s.removePrefix("0x").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    // The card of the vectors in the test log's scope, and the list and challenge it signed the declaration code of.
    private val inputs = vectors("circuit-inputs.json")
    private val case = inputs.getJSONArray("cases").objects().first { it.getString("scope_string") == String(DeviceCore.scopeString(), Charsets.US_ASCII) }
    private val declared = vectors("declaration-code.json").getJSONArray("cases").objects().first { it.getString("declaration_code") == case.getString("declaration_code") }
    private val issuers = JSONArray(inputs.getJSONArray("issuers").objects().map { JSONObject().put("issuer", it.getString("issuer")).put("modulus", it.getString("modulus").removePrefix("0x")) })
    private val certificate = unhex(case.getString("certificate"))
    private val scopeSignature = unhex(case.getString("scope_signature"))
    private val codeSignature = unhex(case.getString("declaration_code_signature"))
    private val crl = unhex(vectors("revocation-tree.json").getJSONArray("crls").objects().first { it.getString("name") == case.getString("crl") }.getString("crl"))
    private val crlSha256 = hex(MessageDigest.getInstance("SHA-256").digest(crl))

    /** Noon in Taiwan on the day of the card's vector: its certificate is valid, and the challenge is dated that day. */
    private val now = java.time.LocalDate.parse(declared.getString("challenge").substring(0, 10)).toEpochDay() * 86_400_000 + 4 * 3_600_000

    private val config = """{"paused":false,"crl_max_age_days":7,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}],"min_app":{"android":{"build":1,"from":"2026-11-20"}}}"""

    /** A card without a record (spec/vectors/card-status.json, "a card without a record"). */
    private val cardState = """{"last_card_proof":null,"proofs_on_last_date":0,"daily_limit":3,"platforms":{"threads":{"current":null,"last_declared":null,"switch_count":0}},"count":137}"""

    /** An answer of the back end: its status and its body. */
    private class Answer(val status: Int, val body: ByteArray) {
        constructor(status: Int, body: String) : this(status, body.toByteArray())
    }

    /**
     * The back end: answers each request (`METHOD /path?query`) as the Worker would, unless the test queued an answer for it in
     * [turnAway], which is then given once. Every request that came is in [requests], with its body.
     */
    private inner class Server {
        val requests = CopyOnWriteArrayList<Pair<String, String>>()
        val turnAway = ConcurrentHashMap<String, ConcurrentLinkedQueue<Answer>>()
        private val socket = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
        val site = "http://127.0.0.1:${socket.localPort}"

        init {
            thread(isDaemon = true) {
                while (true) {
                    val c = try {
                        socket.accept()
                    } catch (e: java.io.IOException) {
                        return@thread
                    }
                    thread(isDaemon = true) { c.use { serve(it) } }
                }
            }
        }

        fun away(request: String, status: Int, code: String) {
            turnAway.getOrPut(request) { ConcurrentLinkedQueue() }.add(Answer(status, """{"error":"$code"}"""))
        }

        /** The requests that came, without their bodies. */
        val lines: List<String> get() = requests.map { it.first }

        private fun serve(c: Socket) {
            val input = BufferedInputStream(c.getInputStream())
            val head = StringBuilder()
            while (!head.endsWith("\r\n\r\n")) {
                val b = input.read()
                if (b < 0) return
                head.append(b.toChar())
            }
            val length = Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
            val body = String(ByteArray(length) { input.read().toByte() }, Charsets.UTF_8)
            val request = head.lineSequence().first().substringBeforeLast(" ")
            requests += request to body
            val answer = turnAway[request]?.poll() ?: answer(request)
            val bytes = answer.body
            val reason = mapOf(200 to "OK", 201 to "Created", 404 to "Not Found", 429 to "Too Many Requests", 503 to "Service Unavailable")[answer.status]
            val extra = if (answer.status == 429 || answer.status == 503) "Retry-After: 60\r\nX-Request-Id: 0123456789abcdef\r\n" else ""
            c.getOutputStream().apply {
                write("HTTP/1.1 ${answer.status} $reason\r\nContent-Type: application/json\r\n${extra}Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray() + bytes)
                flush()
            }
        }

        private fun answer(request: String): Answer = when (request) {
            "GET /api/v1/config", "GET /api/v1/config?start" -> Answer(200, config)
            "GET /crl/index.jsonl" -> Answer(200, """{"issuer":"${case.getString("issuer")}","crl_number":"1","sha256":"$crlSha256","root":"${"0".repeat(64)}"}""" + "\n")
            "GET /crl/$crlSha256.crl" -> Answer(200, crl)
            "POST /api/v1/card-state" -> Answer(200, cardState)
            "POST /api/v1/challenges" -> Answer(200, """{"challenge":"${declared.getString("challenge")}"}""")
            // What the core cannot read is nothing told: the record is made all the same (spec/records-response.md).
            "POST /api/v1/records" -> Answer(201, "{}")
            else -> Answer(404, """{"error":"not_found"}""")
        }

        fun close() = socket.close()
    }

    /** The card of the vectors: its certificate, and its two signatures, over the scope string and over the declaration code. */
    private inner class VectorCard : Card {
        var taps = 0
        var pinsHanded = 0

        override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T {
            taps++
            return use(object : CardConnection {
                override fun readCertificates() = listOf(certificate.copyOf())

                override fun sign(message: ByteArray, pin: ByteArray): ByteArray {
                    pinsHanded++
                    return (if (message.contentEquals(DeviceCore.scopeString())) scopeSignature else codeSignature).copyOf()
                }

                override val pinAccepted = true
            })
        }
    }

    private val servers = mutableListOf<Server>()

    @After
    fun close() = servers.forEach { it.close() }

    private fun server() = Server().also { servers += it }

    /** A card proof against [server], its `config` without the mark asked as the app asks it; [started], the start's of a card proof before it. */
    private fun flow(server: Server, card: Card, started: ByteArray? = null) = CardProof(
        object : CardProof.Deps {
            override val backend = Backend(server.site, server.site)
            override val card = card
            override fun config() = backend.config()
            override fun openSession() = TestingCore.sessionOpen(issuers.toString().toByteArray())
            override fun bundled(name: String) = this@BusyTest.bundled(name)
            override fun now() = now
            override val appBuild = 1
            override val crlNumbers = object : CardProof.CrlNumbers {
                private val numbers = mutableMapOf<String, String>()
                override fun get(issuer: String) = numbers[issuer]
                override fun set(issuer: String, number: String) {
                    numbers[issuer] = number
                }
            }
            override val counts = recorded.counts
            override val attempt = recorded.counts.attempt()
        },
        started,
    )

    /** The counts the card proofs of a test sent (#433). */
    private val recorded = RecordedCounts()

    private val events = object : CardProof.Events {}

    private fun stopOf(f: () -> Unit): Stop {
        try {
            f()
        } catch (e: Stop) {
            return e
        }
        throw AssertionError("no stop")
    }

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
        assertEquals(listOf("GET /api/v1/config?start", "GET /api/v1/config", "GET /crl/index.jsonl", "GET /crl/$crlSha256.crl"), server.lines)
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
        val f = flow(server, card)
        f.begin()
        // The reading's config turned away too: the card proof goes on with the start's, and goes through.
        server.away("GET /api/v1/config", 429, "rate_limited")
        f.readCard(events)
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
        assertEquals(2, server.bodies("POST /api/v1/challenges").size)

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
