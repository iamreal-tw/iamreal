package tw.iamreal.app.flow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
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
 * What [BusyTest] and [ChallengeFirstTest] run card proofs against: a fake back end on this computer that answers as the Worker
 * does, and a card of spec/vectors/ (test keys) held to the phone. The core is the library of the tests, so a card proof here
 * goes as far as the record sent.
 */
abstract class VectorCardProofTest {
    protected fun vectors(name: String) = JSONObject(File(System.getProperty("iamreal.vectors"), name).readText())

    protected fun bundled(name: String): ByteArray = System.getProperty("iamreal.bundled").split(File.pathSeparator)
        .map { File(it, name) }.first { it.isFile }.readBytes()

    protected fun unhex(s: String): ByteArray = s.removePrefix("0x").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    protected fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    protected fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    // The card of the vectors in the test log's scope, and the list and challenge it signed the declaration code of.
    protected val inputs = vectors("circuit-inputs.json")
    protected val case = inputs.getJSONArray("cases").objects().first { it.getString("scope_string") == String(DeviceCore.scopeString(), Charsets.US_ASCII) }
    protected val declared = vectors("declaration-code.json").getJSONArray("cases").objects().first { it.getString("declaration_code") == case.getString("declaration_code") }
    protected val issuers = JSONArray(inputs.getJSONArray("issuers").objects().map { JSONObject().put("issuer", it.getString("issuer")).put("modulus", it.getString("modulus").removePrefix("0x")) })
    protected val certificate = unhex(case.getString("certificate"))
    protected val scopeSignature = unhex(case.getString("scope_signature"))
    protected val codeSignature = unhex(case.getString("declaration_code_signature"))
    protected val crl = unhex(vectors("revocation-tree.json").getJSONArray("crls").objects().first { it.getString("name") == case.getString("crl") }.getString("crl"))
    protected val crlSha256 = hex(MessageDigest.getInstance("SHA-256").digest(crl))

    /** Noon in Taiwan on the day of the card's vector: its certificate is valid, and the challenge is dated that day. */
    protected val now = java.time.LocalDate.parse(declared.getString("challenge").substring(0, 10)).toEpochDay() * 86_400_000 + 4 * 3_600_000

    protected val config = """{"paused":false,"crl_max_age_days":7,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}],"min_app":{"android":{"build":1,"from":"2026-11-20"}}}"""

    /** A card without a record (spec/vectors/card-status.json, "a card without a record"). */
    protected val cardState = """{"last_card_proof":null,"proofs_on_last_date":0,"daily_limit":3,"platforms":{"threads":{"current":null,"last_declared":null,"switch_count":0}},"count":137}"""

    /** An answer of the back end: its status and its body. */
    protected class Answer(val status: Int, val body: ByteArray) {
        constructor(status: Int, body: String) : this(status, body.toByteArray())
    }

    /**
     * The back end: answers each request (`METHOD /path?query`) as the Worker would, unless the test queued an answer for it in
     * [turnAway], which is then given once. Every request that came is in [requests], with its body.
     */
    protected inner class Server {
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

        /**
         * Answers of the test's own, asked before the usual one for every request that is not turned away: the request line and
         * its body; null for the usual answer.
         */
        @Volatile var answers: (request: String, body: String) -> Answer? = { _, _ -> null }

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
            val answer = turnAway[request]?.poll() ?: answers(request, body) ?: answer(request)
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
    protected inner class VectorCard : Card {
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

    protected val servers = mutableListOf<Server>()

    @After
    fun close() = servers.forEach { it.close() }

    protected fun server() = Server().also { servers += it }

    /**
     * A card proof against [server], its `config` without the mark asked as the app asks it; [started], the start's of a card
     * proof before it; [clock], the phone's ([now] by default).
     */
    protected fun flow(server: Server, card: Card, started: ByteArray? = null, clock: () -> Long = { now }) = CardProof(
        object : CardProof.Deps {
            override val backend = Backend(server.site, server.site)
            override val card = card
            override fun config() = backend.config()
            override fun openSession() = TestingCore.sessionOpen(issuers.toString().toByteArray())
            override fun bundled(name: String) = this@VectorCardProofTest.bundled(name)
            override fun now() = clock()
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
    protected val recorded = RecordedCounts()

    protected val events = object : CardProof.Events {}

    protected fun stopOf(f: () -> Unit): Stop {
        try {
            f()
        } catch (e: Stop) {
            return e
        }
        throw AssertionError("no stop")
    }
}
