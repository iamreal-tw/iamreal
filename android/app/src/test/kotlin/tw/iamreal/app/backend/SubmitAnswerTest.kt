package tw.iamreal.app.backend

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import tw.iamreal.app.flow.CardProof
import java.io.BufferedInputStream
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * The answer to a submission (#264): a `201` is a record in the proof log whatever follows it
 * (spec/records-response.md). A body cut short, or longer than the app reads (1 MiB), is no bytes, not a
 * failure: the done screen then says only that the proof log recorded the card proof (`done.recorded_only`,
 * which the vectors' empty body gives: AnswerTest, DoneViewTest). Against a server on this computer that
 * answers one request with bytes written by hand, so the body can stop where a network would cut it.
 */
class SubmitAnswerTest {
    private val mib = 1 shl 20

    /** Answers the one request it gets with [head] and then [body], and closes the connection. Returns the site's address. */
    private fun server(head: String, body: ByteArray): String {
        val socket = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            socket.use { s ->
                s.accept().use { c ->
                    val input = BufferedInputStream(c.getInputStream())
                    // The request's head, then as many bytes as its Content-Length says.
                    val lines = StringBuilder()
                    while (!lines.endsWith("\r\n\r\n")) lines.append(input.read().toChar())
                    val length = Regex("(?i)content-length: *(\\d+)").find(lines)?.groupValues?.get(1)?.toInt() ?: 0
                    repeat(length) { input.read() }
                    val out = c.getOutputStream()
                    out.write(head.toByteArray())
                    // In pieces, so that a cut is a cut and not one write the client sees whole or not at all.
                    body.toList().chunked(16 * 1024).forEach { out.write(it.toByteArray()); out.flush() }
                }
            }
        }
        return "http://127.0.0.1:${socket.localPort}"
    }

    private fun submit(head: String, body: ByteArray): ByteArray =
        Backend(server(head, body), "http://127.0.0.1:1").submit("{}".toByteArray())

    private fun created(length: Int) = "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: $length\r\nConnection: close\r\n\r\n"

    /** What the done screen is given for those bytes: nothing told, so it says only that it was recorded. */
    private fun nothingTold(answer: ByteArray) {
        val read = CardProof.Answer.of(answer, "[]".toByteArray())
        assertNull(read.seq)
        assertNull(read.kinds)
    }

    /**
     * A body sent in chunks, cut in the middle of one: the connection closes where the next bytes should be.
     * (A body of a stated Content-Length cut short is read as the bytes that came by the JDK's
     * HttpURLConnection these tests run on, and as an IOException by Android's; a chunked one cut short is
     * an IOException on both, the case the app's handling is for.)
     */
    private val cutChunked = "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"

    @Test
    fun `a 201 whose body stops in the middle is no bytes, not network`() {
        val answer = try {
            // A chunk of 1000 bytes announced, 10 sent.
            submit(cutChunked, "3e8\r\n".toByteArray() + ByteArray(10) { '{'.code.toByte() })
        } catch (e: ServerException) {
            fail("a 201 cut short is a record made, not ${e.code}")
            return
        }
        assertEquals(0, answer.size)
        nothingTold(answer)
    }

    @Test
    fun `a 201 whose body is longer than 1 MiB is no bytes, not network`() {
        val answer = try {
            submit(created(mib + 1), ByteArray(mib + 1) { ' '.code.toByte() })
        } catch (e: ServerException) {
            fail("a 201 too long to read is a record made, not ${e.code}")
            return
        }
        assertEquals(0, answer.size)
        nothingTold(answer)
    }

    @Test
    fun `a 201 of exactly 1 MiB, and one whole, give their bytes as they came`() {
        val whole = """{"seq":1}""".toByteArray()
        assertArrayEquals(whole, submit(created(whole.size), whole))
        val most = ByteArray(mib) { ' '.code.toByte() }
        assertArrayEquals(most, submit(created(most.size), most))
    }

    @Test
    fun `a refusal is still a refusal with its code, not no bytes`() {
        val body = """{"error":"paused"}""".toByteArray()
        try {
            submit("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n", body)
            fail("a 503 was taken for a record")
        } catch (e: ServerException) {
            assertEquals("paused", e.code)
        }
    }
}
