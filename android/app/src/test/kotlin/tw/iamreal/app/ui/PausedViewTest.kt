package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import tw.iamreal.app.backend.Backend
import tw.iamreal.app.backend.ServerException
import tw.iamreal.app.flow.Stop
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * What the screens say when the server answers `paused` (docs/api/card-proof.md; #394): its own sentence (stops.paused), and
 * only a new card proof, not the same request again. Against a fake back end on this computer that answers `challenges` and
 * `records` with `503` `paused`, as the Worker does while card proofs are stopped. The sentences are read from
 * design/copy/card-proof.json; step 1's (before.paused) is drawn by the screen, in place of common.next.
 */
class PausedViewTest {
    private val copy = Copy(File(System.getProperty("iamreal.copy"), "card-proof.json").readText())
    private val messages = Messages(copy)

    /** Answers the one request it gets with `503` `paused`. Returns the site's address. */
    private fun paused(): String {
        val socket = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            socket.use { s ->
                s.accept().use { c ->
                    val input = c.getInputStream().buffered()
                    val head = StringBuilder()
                    while (!head.endsWith("\r\n\r\n")) {
                        val b = input.read()
                        if (b < 0) return@thread
                        head.append(b.toChar())
                    }
                    val length = Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
                    repeat(length) { input.read() }
                    val body = """{"error":"paused"}""".toByteArray()
                    c.getOutputStream().write("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nX-Request-Id: 0123456789abcdef\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray() + body)
                }
            }
        }
        return "http://127.0.0.1:${socket.localPort}"
    }

    /** What the flow makes of a request the server answered `paused` (CardProof.declare: Stop.server for challenges, and for records with submitting). */
    private fun stopOf(request: (Backend) -> Unit, submitting: Boolean): Stop {
        val site = paused()
        try {
            request(Backend(site, site))
        } catch (e: ServerException) {
            assertEquals("paused", e.code)
            return if (submitting) Stop("server", mapOf("code" to e.code, "submitting" to "true"), e.requestId) else Stop.server(e)
        }
        throw AssertionError("the server's 503 paused was not a refusal")
    }

    @Test
    fun `challenges answered paused - step 5 says stops paused, and only back to the beginning`() {
        val stop = stopOf({ it.challenge() }, submitting = false)
        assertEquals(copy.say("stops.paused"), messages.stop(stop, Messages.At.DECLARE))
        assertEquals(ProgressButton.RESTART, progressButtonAfter(stop))
        assertEquals("0123456789abcdef", stop.requestId)
    }

    @Test
    fun `records answered paused - step 5 says stops paused, not that sending failed, and only back to the beginning`() {
        val stop = stopOf({ it.submit("{}".toByteArray()) }, submitting = true)
        assertEquals(copy.say("stops.paused"), messages.stop(stop, Messages.At.DECLARE))
        assertEquals(ProgressButton.RESTART, progressButtonAfter(stop))
        assertEquals("0123456789abcdef", stop.requestId)
    }

    @Test
    fun `config says paused on the way - step 2 says stops paused, and a new card proof, not the tap again`() {
        val stop = Stop("server", mapOf("code" to "paused"))
        assertEquals(copy.say("stops.paused"), messages.stop(stop, Messages.At.READ))
        assertEquals(ReadButton.RESTART, readButtonAfter(stop))
    }
}
