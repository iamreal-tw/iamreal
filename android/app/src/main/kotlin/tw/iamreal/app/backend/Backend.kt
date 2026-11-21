package tw.iamreal.app.backend

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The requests of a card proof (docs/api/card-proof.md): the server's API
 * on [site], and the CRL archive on [data] (ADR-0027). The two origins are
 * the build's (Target.kt); nothing a server answers changes them.
 *
 * No request carries a cookie or anything of the phone: no identifier, no
 * version, no failure of the app's own checks (ADR-0016). An answer is the
 * bytes of its body as they came; the core reads them. Every call blocks:
 * for a background thread.
 */
class Backend(private val site: String, private val data: String) {
    /** `GET /api/v1/config`: the body. */
    fun config(): ByteArray = request("GET", "$site/api/v1/config", null, API_TIMEOUT_MS, MAX_ANSWER)

    /** `POST /api/v1/card-state` with [body], the core's: the body of the answer. */
    fun cardState(body: ByteArray): ByteArray = request("POST", "$site/api/v1/card-state", body, API_TIMEOUT_MS, MAX_ANSWER)

    /** `POST /api/v1/challenges`: the challenge, as the server issued it. */
    fun challenge(): String {
        val answer = request("POST", "$site/api/v1/challenges", null, API_TIMEOUT_MS, MAX_ANSWER)
        return try {
            JSONObject(String(answer, Charsets.UTF_8)).getString("challenge")
        } catch (e: org.json.JSONException) {
            throw ServerException("malformed_response", 200, null)
        }
    }

    /**
     * `POST /api/v1/records` with [body], the core's: the body of the answer, which is a `201` and no other
     * status. A `201` is a record in the roster whatever follows it (spec/records-response.md): a body that
     * does not arrive whole is no bytes, not a failure.
     */
    fun submit(body: ByteArray): ByteArray = request("POST", "$site/api/v1/records", body, API_TIMEOUT_MS, MAX_ANSWER, created = true)

    /** The index of the CRL archive, `crl/index.jsonl`. */
    fun crlIndex(): ByteArray = request("GET", "$data/crl/index.jsonl", null, FILE_TIMEOUT_MS, MAX_INDEX)

    /** A file of the CRL archive, by the SHA-256 the core chose from the index. */
    fun crl(sha256: String): ByteArray {
        require(sha256.length == 64 && sha256.all { it in '0'..'9' || it in 'a'..'f' })
        return request("GET", "$data/crl/$sha256.crl", null, FILE_TIMEOUT_MS, MAX_CRL)
    }

    private fun request(method: String, url: String, body: ByteArray?, timeoutMs: Int, most: Int, created: Boolean = false): ByteArray {
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
                connection.outputStream.use { if (body != null) it.write(body) }
            }
            val status = connection.responseCode
            val requestId = connection.getHeaderField("X-Request-Id")?.takeIf { id -> id.length in 1..64 && id.all { it.isLetterOrDigit() || it == '-' } }
            if (status !in 200..299) {
                val code = try {
                    JSONObject(String(read(connection.errorStream ?: throw IOException(), MAX_ANSWER), Charsets.UTF_8)).getString("error")
                        .takeIf { c -> c.length in 1..40 && c.all { it in 'a'..'z' || it == '_' } }
                } catch (e: Exception) {
                    null
                }
                throw ServerException(code ?: "http_$status", status, requestId)
            }
            if (created) {
                if (status != 201) throw ServerException("http_$status", status, requestId)
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
class ServerException(val code: String, val status: Int, val requestId: String?) : Exception(code)
