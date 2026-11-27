package tw.iamreal.app.backend

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.net.URL

/**
 * The requests of a card proof (docs/api/card-proof.md): the server's API
 * on [site], and the CRL archive on [data] (ADR-0027). The two origins are
 * the build's (Target.kt); nothing a server answers changes them.
 *
 * No request carries a cookie. Of the phone, only the counts ([count]) and
 * the submission carry anything: the card proof device ID, and in a count
 * the system's version, the app's and the phone's model, and a failure as a
 * code of the table (spec/counts.md; ADR-0032, ADR-0039). An answer is the
 * bytes of its body as they came; the core reads them. Every call blocks:
 * for a background thread.
 */
class Backend(private val site: String, private val data: String) {
    /**
     * `GET /api/v1/config`: the body. With [start], `GET /api/v1/config?start`: the one request of a card proof's start, which
     * the server counts against its site-wide limit (docs/api/card-proof.md, ADR-0026).
     */
    fun config(start: Boolean = false): ByteArray = request("GET", if (start) "$site/api/v1/config?start" else "$site/api/v1/config", null, API_TIMEOUT_MS, MAX_ANSWER)

    /** `POST /api/v1/card-state` with [body], the core's: the body of the answer. */
    fun cardState(body: ByteArray): ByteArray = request("POST", "$site/api/v1/card-state", body, API_TIMEOUT_MS, MAX_ANSWER)

    /**
     * `POST /api/v1/challenges`: the challenge, as the server issued it. Sent once more when the first went out and
     * the first line of an answer did not come (issue #404): the connection the app kept from an earlier
     * request may have gone dead while the cardholder was on steps 4 and 5, and asking again costs nothing but a
     * challenge the server issued for no one. The only request that is: a submission is never sent twice by itself.
     */
    fun challenge(): String {
        val answer = request("POST", "$site/api/v1/challenges", null, API_TIMEOUT_MS, MAX_ANSWER, again = true)
        return try {
            JSONObject(String(answer, Charsets.UTF_8)).getString("challenge")
        } catch (e: org.json.JSONException) {
            throw ServerException("malformed_response", 200, null)
        }
    }

    /**
     * `POST /api/v1/records` with [body], the core's: the body of the answer, which is a `201` and no other
     * status. A `201` is a record in the proof log whatever follows it (spec/records-response.md): a body that
     * does not arrive whole is no bytes, not a failure.
     */
    fun submit(body: ByteArray): ByteArray = request("POST", "$site/api/v1/records", body, API_TIMEOUT_MS, MAX_ANSWER, created = true)

    /**
     * `POST /api/v1/counts` with [body], the core's (`idc_count`). Its answer says nothing and is not read; a count that
     * does not get through is nobody's failure, and is not sent again.
     */
    fun count(body: ByteArray) {
        try {
            request("POST", "$site/api/v1/counts", body, API_TIMEOUT_MS, MAX_ANSWER)
        } catch (e: ServerException) {
            // Not taken, or not answered: the same.
        }
    }

    /** The index of the CRL archive, `crl/index.jsonl`. */
    fun crlIndex(): ByteArray = request("GET", "$data/crl/index.jsonl", null, FILE_TIMEOUT_MS, MAX_INDEX)

    /** A file of the CRL archive, by the SHA-256 the core chose from the index. */
    fun crl(sha256: String): ByteArray {
        require(sha256.length == 64 && sha256.all { it in '0'..'9' || it in 'a'..'f' })
        return request("GET", "$data/crl/$sha256.crl", null, FILE_TIMEOUT_MS, MAX_CRL)
    }

    /**
     * [again]: a request that went out and got no first line of an answer is made once more. The system's client has
     * dropped the connection that failed, so the second goes on another: a new one, unless it kept a second one to the server.
     */
    private fun request(method: String, url: String, body: ByteArray?, timeoutMs: Int, most: Int, created: Boolean = false, again: Boolean = false): ByteArray =
        try {
            once(method, url, body, timeoutMs, most, created)
        } catch (e: Unanswered) {
            if (!again) throw ServerException(NETWORK, 0, null)
            try {
                once(method, url, body, timeoutMs, most, created)
            } catch (e: Unanswered) {
                throw ServerException(NETWORK, 0, null)
            }
        }

    /** The request went out, or may have, and the first line of an answer did not come: the connection was closed, or the time limit ran out. */
    private class Unanswered : Exception()

    private fun once(method: String, url: String, body: ByteArray?, timeoutMs: Int, most: Int, created: Boolean): ByteArray {
        val connection = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            throw ServerException(NETWORK, 0, null)
        }
        try {
            connection.requestMethod = method
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            // In place of Android's own, which names the phone's model and its version of Android.
            connection.setRequestProperty("User-Agent", USER_AGENT)
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            if (method == "POST") {
                connection.doOutput = true
                if (body != null) connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(body?.size ?: 0)
            }
            // Up to the answer's first line. A connection kept from an earlier request may be one the server, or something on the
            // way, has closed: the request then goes out and nothing comes back, at once or when the time limit runs out. The
            // body is sent as it is written and not kept, so the system's own client does not send it again by itself
            // (AOSP's external/okhttp, StreamAllocation.recover). Where in these calls that client fails for such a connection
            // is its own affair, so they are taken together; only a server that could not be connected to at all is told
            // apart, by what the system says of it: then nothing was sent.
            val status = try {
                if (method == "POST") connection.outputStream.use { if (body != null) it.write(body) }
                connection.responseCode
            } catch (e: ConnectException) {
                throw ServerException(NETWORK, 0, null)
            } catch (e: UnknownHostException) {
                throw ServerException(NETWORK, 0, null)
            } catch (e: NoRouteToHostException) {
                throw ServerException(NETWORK, 0, null)
            } catch (e: IOException) {
                throw Unanswered()
            }
            val requestId = connection.getHeaderField("X-Request-Id")?.takeIf { id -> id.length in 1..64 && id.all { it.isLetterOrDigit() || it == '-' } }
            if (status !in 200..299) throw ServerException(errorCode { connection.errorStream } ?: "http_$status", status, requestId)
            if (created) {
                // Another 2xx is not a record made: like a refusal, by the code its body names.
                if (status != 201) throw ServerException(errorCode { connection.inputStream } ?: "http_$status", status, requestId)
                return try {
                    read(connection.inputStream, most)
                } catch (e: IOException) {
                    ByteArray(0)
                }
            }
            return read(connection.inputStream, most)
        } catch (e: IOException) {
            throw ServerException(NETWORK, 0, null)
        } finally {
            connection.disconnect()
        }
    }

    /** The `error` of an answer's body, where it has one the app can show; null otherwise. */
    private fun errorCode(body: () -> java.io.InputStream?): String? = try {
        JSONObject(String(read(body() ?: throw IOException(), MAX_ANSWER), Charsets.UTF_8)).getString("error")
            .takeIf { c -> c.length in 1..40 && c.all { it in 'a'..'z' || it == '_' } }
    } catch (e: Exception) {
        null
    }

    /** The whole body, or an [IOException] for one longer than [most] bytes. */
    private fun read(stream: java.io.InputStream, most: Int): ByteArray = stream.use {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = it.read(buffer)
            if (n < 0) break
            if (out.size() + n > most) throw IOException()
            out.write(buffer, 0, n)
        }
        out.toByteArray()
    }

    companion object {
        /** What every request calls itself: the same for every phone and every version of the app. */
        const val USER_AGENT = "iamreal"

        /** The code of a request that got no answer: no connection, a time limit, a body cut short or too long. */
        const val NETWORK = "network"

        // The time limits of web/src/api.ts: a small JSON answer, and a file of the CRL archive.
        private const val API_TIMEOUT_MS = 30_000
        private const val FILE_TIMEOUT_MS = 5 * 60_000

        // The most the app reads of an answer: a JSON answer; the index; a CRL (G2's is 16.9 MB).
        private const val MAX_ANSWER = 1 shl 20
        private const val MAX_INDEX = 16 shl 20
        private const val MAX_CRL = 64 shl 20
    }
}

/**
 * The server answered with an error, or did not answer ([Backend.NETWORK]).
 * [code] is the server's error code, or `http_<status>` when it sent none;
 * [requestId] the answer's `X-Request-Id`, which the screen shows next to
 * the error (docs/api/card-proof.md).
 */
class ServerException(val code: String, val status: Int, val requestId: String?) : Exception(code) {
    /**
     * The server turned the request away as too many: rate limited (`429`), or the proof log overloaded or too many card proofs
     * starting (`503` `busy`). The same request can be sent again later (docs/api/card-proof.md, "Rules for every endpoint").
     */
    val tooMany: Boolean get() = status == 429 || (status == 503 && code == "busy")
}
