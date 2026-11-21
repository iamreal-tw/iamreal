package tw.iamreal.app.fake

import org.json.JSONObject
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.CardException
import tw.iamreal.app.card.TapCancel
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/**
 * The test's side of the emulator test (android/test/card-proof.ts): what
 * the fake build asks it besides what the app asks a server.
 *
 *   GET /__test/issuers   the issuer keys the test made, as
 *                         idc_testing_session_open takes them
 *   GET /__test/tap       answers when the test holds a card to the phone:
 *                         {"certificates":["<base64 DER>",…],
 *                          "key":"<base64 PKCS#8>","pin":"…","pause_ms":0}
 *                         or 204 when the test takes the tap back.
 *                         pause_ms: how long the card takes over each thing
 *                         (its certificates, a signature, leaving the
 *                         phone), so that a test can read the panel
 *   GET /__test/pin       tells the test that a card was handed a PIN,
 *                         whichever PIN and whichever card: how a test
 *                         sees that a card it held out got none
 */
internal class TestSide(private val origin: String) {
    fun issuers(): ByteArray = get("/__test/issuers") ?: throw IOException("no issuers")

    /** The body of a `200`, or null for another answer. [opened] is told the connection, so that it can be closed from elsewhere. */
    fun get(path: String, opened: (HttpURLConnection) -> Unit = {}): ByteArray? {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        opened(connection)
        try {
            connection.connectTimeout = 10_000
            // A tap waits until the test holds a card to the phone.
            connection.readTimeout = 10 * 60_000
            return if (connection.responseCode == 200) connection.inputStream.use { it.readBytes() } else null
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * A card that is not there: test keys, in the app's memory. Each tap asks
 * the test which card is held to the phone, so the test can hold another
 * one the next time. It answers as a real card does: its certificates
 * without a PIN, a signature only with its PIN.
 */
internal class FakeCard(private val side: TestSide) : Card {
    override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T {
        val held = try {
            // Cancelling ends the wait for the test's answer.
            side.get("/__test/tap") { connection -> cancel.onCancel { Thread { connection.disconnect() }.start() } }
        } catch (e: IOException) {
            null
        }
        if (cancel.isCancelled) throw CardException(CardException.Reason.CANCELLED)
        val card = JSONObject(String(held ?: throw CardException(CardException.Reason.NO_TAP), Charsets.UTF_8))
        val decode = Base64.getDecoder()
        val pause = card.optLong("pause_ms")
        return use(object : CardConnection {
            override fun readCertificates(): List<ByteArray> {
                Thread.sleep(pause)
                return card.getJSONArray("certificates").let { list -> (0 until list.length()).map { decode.decode(list.getString(it)) } }
            }

            override fun sign(message: ByteArray, pin: ByteArray): ByteArray {
                side.get("/__test/pin")
                if (!pin.contentEquals(card.getString("pin").toByteArray())) throw CardException(CardException.Reason.PIN_INCORRECT)
                Thread.sleep(pause)
                val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(decode.decode(card.getString("key"))))
                return Signature.getInstance("SHA256withRSA").run {
                    initSign(key)
                    update(message)
                    sign()
                }
            }
        }).also { Thread.sleep(pause) }
    }
}
