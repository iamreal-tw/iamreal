package tw.iamreal.app.card

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The commands to the card, against a card simulated here: what is sent
 * before the PIN, that the PIN goes once and only into a working channel,
 * and how a tap ends. The simulated card checks each command of the
 * channel as spec/card-channel.md writes it (its MAC, and its data
 * decrypted with the counter the card keeps) and refuses one that is
 * wrong, as a card does. Whether the app's key material is a real card's
 * is for a real card to show (android/README.md, "真卡片的測試清單").
 */
class GpkiCardTest {
    private val message = "iamreal-test:public:0".toByteArray()
    private val pin = "123456".toByteArray()

    @Test
    fun `the certificates are read in the card's order, and the channel is tried, without the PIN`() {
        val card = SimulatedCard()
        val read = GpkiCard(card::transceive, TapCancel()).use { it.readCertificates() }
        assertEquals(listOf(hex(SimulatedCard.SIGNING_CERTIFICATE), hex(SimulatedCard.OTHER_CERTIFICATE)), read.map { hex(it) })
        assertTrue("the card took an encrypted command", card.encryptedCommands > 0)
        assertFalse("no PIN", card.sent(0x20))
    }

    @Test
    fun `the card verifies the PIN in the channel, then signs the block for the message with the signing key`() {
        val card = SimulatedCard()
        val signature = GpkiCard(card::transceive, TapCancel()).use {
            it.readCertificates()
            it.sign(message, pin)
        }
        assertArrayEquals(card.signature, signature)
        assertEquals(hex(SecureChannel.signBlock(message)), card.signed?.let { hex(it) })
        assertEquals(1, card.pinsReceived)
        assertEquals(SimulatedCard.SIGNING_KEY, card.signedWith)
    }

    @Test
    fun `a card whose cryptogram is not the expected one gets nothing back and no PIN`() {
        val card = SimulatedCard(cryptogramRight = false)
        val e = runCatching { GpkiCard(card::transceive, TapCancel()).use { it.readCertificates() } }.exceptionOrNull()
        assertEquals(CardException.Reason.CHANNEL, (e as CardException).reason)
        assertFalse("no EXTERNAL AUTHENTICATE", card.sent(0x82))
        assertFalse("no PIN", card.sent(0x20))
    }

    @Test
    fun `a channel the card does not take stops the tap before the PIN`() {
        val card = SimulatedCard(refuseEncrypted = true)
        val connection = GpkiCard(card::transceive, TapCancel())
        val e = runCatching { connection.readCertificates() }.exceptionOrNull()
        assertEquals(CardException.Reason.CHANNEL, (e as CardException).reason)
        // Signing on a connection whose reading did not go to its end sends nothing.
        val sent = card.commands.size
        val again = runCatching { connection.sign(message, pin) }.exceptionOrNull()
        assertEquals(CardException.Reason.OTHER, (again as CardException).reason)
        assertEquals(sent, card.commands.size)
        assertFalse("no PIN", card.sent(0x20))
    }

    @Test
    fun `a first-generation card is told apart, and gets nothing more`() {
        val card = SimulatedCard(firstGeneration = true)
        val e = runCatching { GpkiCard(card::transceive, TapCancel()).readCertificates() }.exceptionOrNull()
        assertEquals(CardException.Reason.FIRST_GENERATION, (e as CardException).reason)
        assertEquals(listOf("a4", "a4", "a4"), card.commands.map { "%02x".format(it[1]) })
    }

    @Test
    fun `another card with a master file is not taken for a first-generation card`() {
        val card = SimulatedCard(masterFileOnly = true)
        val e = runCatching { GpkiCard(card::transceive, TapCancel()).readCertificates() }.exceptionOrNull()
        assertEquals(CardException.Reason.OTHER, (e as CardException).reason)
    }

    @Test
    fun `a PIN the card refuses ends the tap, is not sent again, and nothing is signed`() {
        // 6CXX and 61XX, which other commands follow with the command again or GET RESPONSE, included.
        val answers = listOf(
            0x63C2 to CardException.Reason.PIN_INCORRECT,
            0x63C0 to CardException.Reason.LOCKED,
            0x6983 to CardException.Reason.LOCKED,
            0x6C0A to CardException.Reason.OTHER,
            0x6105 to CardException.Reason.OTHER,
        )
        for ((answer, reason) in answers) {
            val card = SimulatedCard(pinAnswer = answer)
            val e = runCatching { GpkiCard(card::transceive, TapCancel()).use { it.readCertificates(); it.sign(message, pin) } }.exceptionOrNull()
            assertEquals("%04X".format(answer), reason, (e as CardException).reason)
            assertEquals("%04X: one VERIFY sent".format(answer), 1, card.commands.count { it[1].toInt() and 0xFF == 0x20 })
            assertEquals("nothing after the PIN", 0x20, card.commands.last()[1].toInt())
        }
    }

    @Test
    fun `a PIN no card takes is not sent`() {
        for (typed in listOf("12345", "12345678901", "12345é")) {
            val card = SimulatedCard()
            val e = runCatching { GpkiCard(card::transceive, TapCancel()).use { it.readCertificates(); it.sign(message, typed.toByteArray()) } }.exceptionOrNull()
            assertEquals(typed, CardException.Reason.PIN_INCORRECT, (e as CardException).reason)
            assertFalse(typed, card.sent(0x20))
        }
    }

    @Test
    fun `a card that leaves while the PIN is on its way is told apart from one that leaves later`() {
        val atPin = SimulatedCard(leaveAt = 0x20)
        val e = runCatching { GpkiCard(atPin::transceive, TapCancel()).use { it.readCertificates(); it.sign(message, pin) } }.exceptionOrNull()
        assertEquals(CardException.Reason.PIN_MAYBE_SENT, (e as CardException).reason)

        val atSigning = SimulatedCard(leaveAt = 0xEA)
        val later = runCatching { GpkiCard(atSigning::transceive, TapCancel()).use { it.readCertificates(); it.sign(message, pin) } }.exceptionOrNull()
        assertEquals(CardException.Reason.DROPPED, (later as CardException).reason)
    }

    @Test
    fun `a tap given up ends at the next command`() {
        val cancel = TapCancel()
        val card = SimulatedCard()
        val e = runCatching {
            GpkiCard(card::transceive, cancel).use {
                it.readCertificates()
                cancel.cancel()
                it.sign(message, pin)
            }
        }.exceptionOrNull()
        assertEquals(CardException.Reason.CANCELLED, (e as CardException).reason)
        assertFalse("no PIN", card.sent(0x20))
    }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
}

/**
 * A second-generation card as far as the app talks to it: the signing
 * application with a PKCS#15 structure (two keys, two certificates), the
 * security domain's identifier and key information, and SCP03 with the
 * app's key material. It signs by answering with bytes of its own.
 */
private class SimulatedCard(
    val firstGeneration: Boolean = false,
    /** Another card: a master file, and nothing of a citizen digital certificate. */
    val masterFileOnly: Boolean = false,
    val cryptogramRight: Boolean = true,
    val refuseEncrypted: Boolean = false,
    val pinAnswer: Int = 0x9000,
    /** The INS of the command during which the card leaves. */
    val leaveAt: Int? = null,
) {
    val commands = mutableListOf<ByteArray>()
    var pinsReceived = 0
    var signed: ByteArray? = null
    var signedWith: Int? = null
    var encryptedCommands = 0
    val signature = ByteArray(256) { (it * 7).toByte() }

    private var application: String? = null
    private var file: Int? = null
    private var host: ByteArray? = null
    private var session: SecureChannel.Session? = null
    private var counter = 0
    private var mcv = ByteArray(0)
    private var pinVerified = false
    private var firstHalf: ByteArray? = null
    private var unread = ByteArray(0)

    fun sent(ins: Int) = commands.any { it[1].toInt() and 0xFF == ins }

    fun transceive(apdu: ByteArray): ByteArray {
        commands += apdu.copyOf()
        val cla = apdu[0].toInt() and 0xFF
        val ins = apdu[1].toInt() and 0xFF
        val p1 = apdu[2].toInt() and 0xFF
        val p2 = apdu[3].toInt() and 0xFF
        val data = if (apdu.size > 5) apdu.copyOfRange(5, 5 + (apdu[4].toInt() and 0xFF)) else ByteArray(0)
        if (ins == leaveAt) throw IOException("the card left")
        if (cla and 0x04 != 0 && ins != 0x82) return secured(cla, ins, p1, p2, data)
        return when (ins) {
            0xA4 -> when {
                p1 == 0x04 -> select(hex(data))
                firstGeneration -> ok()
                masterFileOnly -> if (hex(data) == "3f00") ok() else status(0x6A82)
                else -> selectFile(data)
            }
            0xB0 -> readBinary((p1 shl 8) or p2, apdu.last().toInt() and 0xFF)
            0xCA -> when {
                p2 == 0xE0 && application == "manager" -> ok(unhex("e012c00401300310c00401310310c00401320310"))
                p2 == 0x45 && application == "domain" -> ok(byteArrayOf(0x45, 0x0A) + CARD_ID)
                else -> status(0x6A88)
            }
            0x50 -> initializeUpdate(data)
            0x82 -> externalAuthenticate(apdu, data)
            else -> status(0x6D00)
        }
    }

    private fun select(aid: String): ByteArray {
        if (firstGeneration || masterFileOnly) return status(0x6A82)
        application = mapOf(hex(SecureChannel.GPPKI_AID) to "signing", hex(SecureChannel.ISD_CM_AID) to "manager", hex(SecureChannel.ISD_AID) to "domain")[aid] ?: return status(0x6A82)
        file = null
        session = null
        return ok()
    }

    private fun selectFile(fid: ByteArray): ByteArray {
        val f = ((fid[0].toInt() and 0xFF) shl 8) or (fid[1].toInt() and 0xFF)
        if (application != "signing" || (f !in FILES && f != 0x5030 && f != 0x0810)) return status(0x6A82)
        file = f
        return ok()
    }

    private fun readBinary(offset: Int, le: Int): ByteArray {
        val content = FILES[file] ?: return status(0x6986)
        if (offset >= content.size) return status(0x6B00)
        return ok(content.copyOfRange(offset, minOf(content.size, offset + if (le == 0) 256 else le)))
    }

    private fun initializeUpdate(data: ByteArray): ByteArray {
        if (application != "signing") return status(0x6985)
        host = data
        val keys = SecureChannel.diversify(CARD_ID)
        val context = data + CARD_CHALLENGE
        val cryptogram = SecureChannel.kdf(SecureChannel.kdf(keys.mac, 0x06, context, 128), 0x00, context, 64)
        if (!cryptogramRight) cryptogram[0] = (cryptogram[0].toInt() xor 1).toByte()
        return ok(ByteArray(10) + byteArrayOf(0x30, 0x03, 0x70) + CARD_CHALLENGE + cryptogram)
    }

    private fun externalAuthenticate(apdu: ByteArray, data: ByteArray): ByteArray {
        val opened = SecureChannel.Session.open(SecureChannel.diversify(CARD_ID), host ?: return status(0x6985), SecureChannel.InitializeUpdate(CARD_CHALLENGE, cryptogram()))!!
        if (!opened.externalAuthenticate.header.contentEquals(apdu.copyOf(5)) || !opened.externalAuthenticate.body.contentEquals(data)) return status(0x6300)
        session = opened.session
        mcv = opened.session.mcv
        counter = 0
        return ok()
    }

    private fun cryptogram(): ByteArray {
        val context = host!! + CARD_CHALLENGE
        return SecureChannel.kdf(SecureChannel.kdf(SecureChannel.diversify(CARD_ID).mac, 0x06, context, 128), 0x00, context, 64)
    }

    /** A command in the channel: its MAC checked, its data decrypted with the card's own count of commands. */
    private fun secured(cla: Int, ins: Int, p1: Int, p2: Int, body: ByteArray): ByteArray {
        val s = session ?: return status(0x6982)
        counter++
        val header = byteArrayOf(cla.toByte(), ins.toByte(), p1.toByte(), p2.toByte(), body.size.toByte())
        val cipher = body.copyOf(body.size - 8)
        val mac = SecureChannel.aesCmac(s.sMac, mcv + header + cipher)
        if (!mac.copyOf(8).contentEquals(body.copyOfRange(body.size - 8, body.size))) return status(0x6988)
        mcv = mac
        val data = if (cipher.isEmpty()) ByteArray(0) else decrypt(s, cipher) ?: return status(0x6988)
        encryptedCommands++
        if (refuseEncrypted) return status(0x6988)
        return when (ins) {
            0xA4 -> selectFile(data)
            0x20 -> {
                pinsReceived++
                if (pinAnswer != 0x9000) return status(pinAnswer)
                if (!data.contentEquals("123456".toByteArray() + ByteArray(4) { 0xFF.toByte() })) return status(0x63C2)
                pinVerified = true
                ok()
            }
            0xEA -> {
                if (!pinVerified || file != 0x0810) return status(0x6982)
                if (p1 == 0x82) {
                    firstHalf = data
                    return ok()
                }
                signed = (firstHalf ?: return status(0x6985)) + data
                signedWith = p2
                unread = signature
                ok()
            }
            0xC1 -> {
                val out = unread.copyOf(minOf(128, unread.size))
                unread = unread.copyOfRange(out.size, unread.size)
                ok(out)
            }
            else -> status(0x6D00)
        }
    }

    private fun decrypt(s: SecureChannel.Session, cipher: ByteArray): ByteArray? {
        val iv = Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(s.sEnc, "AES")) }
            .doFinal(ByteArray(12) + byteArrayOf((counter ushr 24).toByte(), (counter ushr 16).toByte(), (counter ushr 8).toByte(), counter.toByte()))
        val padded = Cipher.getInstance("AES/CBC/NoPadding").apply { init(Cipher.DECRYPT_MODE, SecretKeySpec(s.sEnc, "AES"), IvParameterSpec(iv)) }.doFinal(cipher)
        val end = padded.indexOfLast { it != 0.toByte() }
        return if (end >= 0 && padded[end] == 0x80.toByte()) padded.copyOf(end) else null
    }

    private fun ok(data: ByteArray = ByteArray(0)) = data + byteArrayOf(0x90.toByte(), 0x00)

    private fun status(sw: Int) = byteArrayOf((sw shr 8).toByte(), sw.toByte())

    companion object {
        val CARD_ID = unhex("0a0b0c0d0e0f10111213")
        val CARD_CHALLENGE = unhex("c1c2c3c4c5c6c7c8")
        const val SIGNING_KEY = 0x81

        /** Two certificates, longer than one read: only their DER matters here. */
        val SIGNING_CERTIFICATE = der(0x30, ByteArray(700) { 1 })
        val OTHER_CERTIFICATE = der(0x30, ByteArray(500) { 2 })

        private fun key(label: String, id: String, usage: ByteArray, reference: Int) = der(
            0x30,
            der(0x30, der(0x0C, label.toByteArray())) + der(0x30, der(0x04, id.toByteArray()) + der(0x03, usage) + der(0x02, byteArrayOf(reference.toByte()))),
        )

        private fun certificate(id: String, fid: Int, length: Int) = der(
            0x30,
            der(0x30, der(0x0C, id.toByteArray())) + der(0x30, der(0x04, id.toByteArray())) +
                der(0xA1, der(0x30, der(0x30, der(0x04, byteArrayOf(0x50, 0x30, (fid shr 8).toByte(), fid.toByte())) + der(0x02, byteArrayOf(0)) + der(0x80, byteArrayOf((length shr 8).toByte(), length.toByte()))))),
        )

        /** The PKCS#15 files under 5030, padded with ff as a card's are. */
        val FILES = mapOf(
            // An encryption key first, then the signing key: the app finds the one that signs.
            0x4100 to key("ENC", "ENC", byteArrayOf(0x06, 0x00, 0x22), 0x82) + key("SIGN", "SIGN", byteArrayOf(0x06, 0x20, 0x00), SIGNING_KEY) + ByteArray(40) { 0xFF.toByte() },
            0x4104 to certificate("SIGN", 0x4401, SIGNING_CERTIFICATE.size) + certificate("ENC", 0x4402, OTHER_CERTIFICATE.size) + ByteArray(40) { 0xFF.toByte() },
            0x4401 to SIGNING_CERTIFICATE + ByteArray(20) { 0xFF.toByte() },
            0x4402 to OTHER_CERTIFICATE,
        )

        fun der(tag: Int, value: ByteArray): ByteArray {
            val length = when {
                value.size < 0x80 -> byteArrayOf(value.size.toByte())
                value.size < 0x100 -> byteArrayOf(0x81.toByte(), value.size.toByte())
                else -> byteArrayOf(0x82.toByte(), (value.size shr 8).toByte(), value.size.toByte())
            }
            return byteArrayOf(tag.toByte()) + length + value
        }

        fun unhex(s: String): ByteArray = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

        fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    }
}
