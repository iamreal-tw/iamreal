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
 *                          "key":"<base64 PKCS#8>","pin":"…","pause_ms":0,
 *                          "no_channel":false,"leaves":null,"nfc":null}
 *                         or 204 when the test takes the tap back.
 *                         pause_ms: how long the card takes over each thing
 *                         (its certificates, a signature, leaving the
 *                         phone), so that a test can read the panel.
 *                         no_channel: a card the secure channel cannot be
 *                         made with; it stops where card/GpkiCard.kt does,
 *                         reading its certificates, before any PIN.
 *                         leaves: where the card leaves the phone, as
 *                         card/GpkiCard.kt tells each: "reading" (its
 *                         certificates), "pin" (while the PIN is on its way:
 *                         the card got it or not, the app cannot know),
 *                         "signing" (after it accepted the PIN).
 *                         nfc: "off" or "none", a phone whose NFC is turned
 *                         off or that has none, in place of a card
 *   GET /__test/phone     {"nfc":false} for a phone without NFC; any other
 *                         answer, or none, is a phone that has it. Asked
 *                         once, when the app opens
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
    override val hasNfc: Boolean by lazy {
        try {
            side.get("/__test/phone")?.let { JSONObject(String(it, Charsets.UTF_8)).optBoolean("nfc", true) } ?: true
        } catch (e: IOException) {
            true
        } catch (e: org.json.JSONException) {
            true
        }
    }

    override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T {
        val held = try {
            // Cancelling ends the wait for the test's answer.
            side.get("/__test/tap") { connection -> cancel.onCancel { Thread { connection.disconnect() }.start() } }
        } catch (e: IOException) {
            null
        }
        if (cancel.isCancelled) throw CardException(CardException.Reason.CANCELLED)
        val card = JSONObject(String(held ?: throw CardException(CardException.Reason.NO_TAP), Charsets.UTF_8))
        when (card.optString("nfc")) {
            "off" -> throw CardException(CardException.Reason.NFC_OFF)
            "none" -> throw CardException(CardException.Reason.NO_NFC)
        }
        val decode = Base64.getDecoder()
        val pause = card.optLong("pause_ms")
        val leaves = card.optString("leaves")
        return use(object : CardConnection {
            override var pinAccepted = false
                private set

            override fun readCertificates(): List<ByteArray> {
                Thread.sleep(pause)
                if (leaves == "reading") throw CardException(CardException.Reason.DROPPED)
                if (card.optBoolean("no_channel")) throw CardException(CardException.Reason.CHANNEL)
                return card.getJSONArray("certificates").let { list -> (0 until list.length()).map { decode.decode(list.getString(it)) } }
            }

            override fun sign(message: ByteArray, pin: ByteArray): ByteArray {
                side.get("/__test/pin")
                if (leaves == "pin") throw CardException(CardException.Reason.PIN_MAYBE_SENT)
                if (!pin.contentEquals(card.getString("pin").toByteArray())) throw CardException(CardException.Reason.PIN_INCORRECT)
                pinAccepted = true
                Thread.sleep(pause)
                if (leaves == "signing") throw CardException(CardException.Reason.DROPPED)
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
