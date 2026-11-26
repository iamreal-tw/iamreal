package tw.iamreal.app.backend

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * The challenge asked for a second time (#404): a request that went out and got no first line of an answer is made
 * once more, and only for `POST /api/v1/challenges`. Against a server on this computer that
 * reads each request and then answers it, or closes the connection without a byte, as a connection that went dead
 * while the phone waited on steps 4 and 5 does.
 */
class ChallengeAgainTest {
    private val challenge = "{\"challenge\":\"2026-11-16.AAAA\"}"
    private val ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${challenge.length}\r\nConnection: close\r\n\r\n$challenge"

    /** What the server does with a request: an answer to write, or null to close the connection without one. */
    private class Server(private val answers: List<String?>) {
        /** The first line of each request that came, in order. */
        val requests = CopyOnWriteArrayList<String>()
        private val socket = ServerSocket(0, 4, InetAddress.getLoopbackAddress())
        val site = "http://127.0.0.1:${socket.localPort}"

        init {
            thread(isDaemon = true) {
                socket.use { s ->
                    for (answer in answers) {
                        val c = try {
                            s.accept()
                        } catch (e: java.io.IOException) {
                            return@thread
                        }
                        c.use { serve(it, answer) }
                    }
                }
            }
        }

        private fun serve(c: Socket, answer: String?) {
            val input = BufferedInputStream(c.getInputStream())
            val head = StringBuilder()
            while (!head.endsWith("\r\n\r\n")) {
                val b = input.read()
                if (b < 0) return
                head.append(b.toChar())
            }
            val length = Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
            repeat(length) { input.read() }
            requests += head.lineSequence().first()
            // No answer: the connection is closed with the whole request read and nothing written.
            if (answer != null) c.getOutputStream().apply { write(answer.toByteArray()) }.flush()
        }
    }

    private fun network(what: String, ask: () -> Unit) {
        try {
            ask()
            fail("$what: an answer")
        } catch (e: ServerException) {
            assertEquals(what, Backend.NETWORK, e.code)
        }
    }

    private val post = "POST /api/v1/challenges HTTP/1.1"

    @Test
    fun `a challenge that got no byte of an answer is asked for once more, and the second answer is the challenge`() {
        val server = Server(listOf(null, ok))
        assertEquals("2026-11-16.AAAA", Backend(server.site, "http://127.0.0.1:1").challenge())
        assertEquals(listOf(post, post), server.requests.toList())
    }

    @Test
    fun `once more only - a second request without an answer is no answer`() {
        val server = Server(listOf(null, null, ok))
        network("two requests unanswered") { Backend(server.site, "http://127.0.0.1:1").challenge() }
        assertEquals(listOf(post, post), server.requests.toList())
    }

    @Test
    fun `an answer, whatever it says, is not asked for again`() {
        val refused = "{\"error\":\"rate_limited\"}"
        val server = Server(listOf("HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${refused.length}\r\nConnection: close\r\n\r\n$refused", ok))
        try {
            Backend(server.site, "http://127.0.0.1:1").challenge()
            fail("a refusal read as a challenge")
        } catch (e: ServerException) {
            assertEquals(listOf("rate_limited", 429), listOf(e.code, e.status))
        }
        assertEquals(listOf(post), server.requests.toList())
    }

    @Test
    fun `a submission and the card's state are sent once, answer or none`() {
        // Not the GETs: a GET that got no answer the system's own client may send again by itself, as it does here on the JVM.
        val body = "{}".toByteArray()
        for ((what, ask) in listOf<Pair<String, (Backend) -> Unit>>(
            "POST /api/v1/records HTTP/1.1" to { b -> b.submit(body) },
            "POST /api/v1/card-state HTTP/1.1" to { b -> b.cardState(body) },
        )) {
            val server = Server(listOf(null, ok))
            network(what) { ask(Backend(server.site, "http://127.0.0.1:1")) }
            assertEquals(listOf(what), server.requests.toList())
        }
    }
}
