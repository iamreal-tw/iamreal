// Source: the secure channel's steps and key material are from GpkiCard.kt of mctea01/my-Bonds-fork-android (Apache-2.0), commit a8696253: https://github.com/mctea01/my-Bonds-fork-android/blob/a8696253a4c4be6c88a3618fded4c716b13f72fa/core/src/commonMain/kotlin/diw/wallet/core/document/card/GpkiCard.kt
package tw.iamreal.app.card

import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The secure channel a second-generation card requires before it takes the
 * PIN or signs (SCP03 with C-DECRYPTION and C-MAC), as spec/card-channel.md
 * writes it field by field. Nothing here talks to a card: GpkiCard.kt sends
 * the commands.
 */
internal object SecureChannel {
    /** The card manager. Its last five bytes go into the diversification. */
    val ISD_CM_AID = unhex("A000000283FF088692535389C00014")

    /** The security domain, where GET DATA gives the card identifier. */
    val ISD_AID = unhex("A0000001510000")

    /** The signing application. */
    val GPPKI_AID = unhex("A0000002830000062201696400010101")

    private val MASTER_ENC = unhex("eee765099e9b8d52a33734760dd0305e")
    private val DIVERSE_KEK = unhex("434854204869434f53504b4353233131")

    private const val RSA_LEN = 256
    private val SHA256_DIGEST_INFO = unhex("3031300d060960864801650304020105000420")

    class StaticKeys(val enc: ByteArray, val mac: ByteArray) {
        fun wipe() {
            enc.fill(0)
            mac.fill(0)
        }
    }

    /** The card's static keys from its 10-byte identifier (`diversify`). [kek] and [masterEnc] are other than the app's in the vectors only. */
    fun diversify(cardId: ByteArray, kek: ByteArray = DIVERSE_KEK, masterEnc: ByteArray = MASTER_ENC): StaticKeys {
        val master = aesEcb(Cipher.DECRYPT_MODE, kek, masterEnc)
        try {
            return StaticKeys(aesCmac(master, diversifyInput(0x04, cardId)), aesCmac(master, diversifyInput(0x06, cardId)))
        } finally {
            master.fill(0)
        }
    }

    /** What the master key MACs for `k_enc` (constant 04) or `k_mac` (06). */
    fun diversifyInput(constant: Int, cardId: ByteArray): ByteArray {
        require(cardId.size == 10)
        val s = ByteArray(32)
        s[0x0B] = constant.toByte()
        s[0x0E] = 0x80.toByte()
        s[0x0F] = 1
        s[0x10] = if (constant == 0x04) 1 else 2
        cardId.copyInto(s, 0x11)
        ISD_CM_AID.copyInto(s, 0x1B, 10, 15)
        return s
    }

    /** The card identifier in GET DATA tag 45 of the security domain, or null (`card_id`). */
    fun cardId(response: ByteArray): ByteArray? =
        if (response.size >= 12 && response[0] == 0x45.toByte() && response[1] == 0x0A.toByte()) response.copyOfRange(2, 12) else null

    /** The card manager's key information says 16-byte keys (`key_information`). */
    fun keyInformationAccepted(response: ByteArray): Boolean = response.size >= 8 && response[0] == 0xE0.toByte() && response[7] == 0x10.toByte()

    /** The card's answer to INITIALIZE UPDATE (`initialize_update`). */
    class InitializeUpdate(val cardChallenge: ByteArray, val cardCryptogram: ByteArray) {
        companion object {
            /** Null when the card does not answer as SCP03. */
            fun of(response: ByteArray): InitializeUpdate? =
                if (response.size >= 29 && response[11] == 0x03.toByte()) InitializeUpdate(response.copyOfRange(13, 21), response.copyOfRange(21, 29)) else null
        }
    }

    /** A command to the card: its header and what follows it. */
    class ExternalAuthenticate(val header: ByteArray, val body: ByteArray)

    /** A command wrapped for the channel. [counter] and [iv] are what spec/card-channel.md calls them. */
    class Wrapped(val header: ByteArray, val body: ByteArray, val counter: Int, val iv: ByteArray?)

    /**
     * One session (`session`, `sequence`). It counts every command it wraps, with or without data: a card
     * refuses the next encrypted command when one without data was not counted.
     */
    class Session(val sEnc: ByteArray, val sMac: ByteArray, mcv: ByteArray) {
        /** The chaining value the next command starts from. */
        var mcv: ByteArray = mcv
            private set

        /** EXTERNAL AUTHENTICATE, for a session [open] made. */
        lateinit var externalAuthenticate: ExternalAuthenticate
            private set

        private var counter = 0

        fun wrap(cla: Int, ins: Int, p1: Int, p2: Int, data: ByteArray, encrypt: Boolean): Wrapped {
            counter++
            val iv = if (encrypt && data.isNotEmpty()) {
                aesEcb(Cipher.ENCRYPT_MODE, sEnc, ByteArray(12) + byteArrayOf((counter ushr 24).toByte(), (counter ushr 16).toByte(), (counter ushr 8).toByte(), counter.toByte()))
            } else {
                null
            }
            val cipher = if (iv != null) {
                val padded = pad80(data)
                try {
                    aesCbc(sEnc, iv, padded)
                } finally {
                    padded.fill(0)
                }
            } else {
                ByteArray(0)
            }
            val header = byteArrayOf((cla or 0x04).toByte(), ins.toByte(), p1.toByte(), p2.toByte(), (cipher.size + 8).toByte())
            mcv = aesCmac(sMac, mcv + header + cipher)
            return Wrapped(header, cipher + mcv.copyOf(8), counter, iv)
        }

        fun wipe() {
            sEnc.fill(0)
            sMac.fill(0)
        }

        companion object {
            /** The session of [keys], [host] and the card's answer; null when the card's cryptogram is not the expected one. */
            fun open(keys: StaticKeys, host: ByteArray, card: InitializeUpdate): Session? {
                val context = host + card.cardChallenge
                val sMac = kdf(keys.mac, 0x06, context, 128)
                val sEnc = kdf(keys.enc, 0x04, context, 128)
                if (!MessageDigest.isEqual(kdf(sMac, 0x00, context, 64), card.cardCryptogram)) {
                    sMac.fill(0)
                    sEnc.fill(0)
                    return null
                }
                val hostCryptogram = kdf(sMac, 0x01, context, 64)
                val header = byteArrayOf(0x84.toByte(), 0x82.toByte(), 0x03, 0x00, 0x10)
                val mac = aesCmac(sMac, ByteArray(16) + header + hostCryptogram)
                return Session(sEnc, sMac, mac).also { it.externalAuthenticate = ExternalAuthenticate(header, hostCryptogram + mac.copyOf(8)) }
            }
        }
    }

    /** The data of VERIFY (`pin_block`), or null for a PIN no card takes. [pin] is the caller's; the block is the caller's to overwrite. */
    fun pinBlock(pin: ByteArray): ByteArray? {
        if (pin.size !in 6..10 || pin.any { it < 0x20 || it > 0x7E }) return null
        val block = ByteArray(10) { 0xFF.toByte() }
        pin.copyInto(block)
        return block
    }

    /** What the card is given to sign for [message] (`sign_block`). */
    fun signBlock(message: ByteArray): ByteArray {
        val t = SHA256_DIGEST_INFO + MessageDigest.getInstance("SHA-256").digest(message)
        val b = ByteArray(RSA_LEN) { 0xFF.toByte() }
        b[0] = 0
        b[1] = 1
        b[RSA_LEN - t.size - 1] = 0
        t.copyInto(b, RSA_LEN - t.size)
        return b
    }

    fun kdf(key: ByteArray, constant: Int, context: ByteArray, bits: Int): ByteArray {
        val len = (bits + 7) / 8
        var out = ByteArray(0)
        var i = 1
        while (out.size < len) {
            out += aesCmac(key, ByteArray(11) + byteArrayOf(constant.toByte(), 0, (bits shr 8).toByte(), bits.toByte(), i.toByte()) + context)
            i++
        }
        return out.copyOf(len)
    }

    /** AES-CMAC (RFC 4493). */
    fun aesCmac(key: ByteArray, message: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")) }
        val k1 = double(cipher.doFinal(ByteArray(16)))
        val k2 = double(k1)
        val blocks = maxOf(1, (message.size + 15) / 16)
        val complete = message.isNotEmpty() && message.size % 16 == 0
        val last = ByteArray(16)
        val tail = message.copyOfRange((blocks - 1) * 16, message.size)
        tail.copyInto(last)
        if (!complete) last[tail.size] = 0x80.toByte()
        val subkey = if (complete) k1 else k2
        for (j in 0 until 16) last[j] = (last[j].toInt() xor subkey[j].toInt()).toByte()
        var x = ByteArray(16)
        for (b in 0 until blocks - 1) {
            val block = ByteArray(16) { j -> (x[j].toInt() xor message[b * 16 + j].toInt()).toByte() }
            x = cipher.doFinal(block)
        }
        return cipher.doFinal(ByteArray(16) { j -> (x[j].toInt() xor last[j].toInt()).toByte() })
    }

    private fun double(b: ByteArray): ByteArray {
        val out = ByteArray(16)
        for (i in 0 until 16) out[i] = ((b[i].toInt() shl 1) or (if (i < 15) (b[i + 1].toInt() and 0xFF) ushr 7 else 0)).toByte()
        if (b[0].toInt() and 0x80 != 0) out[15] = (out[15].toInt() xor 0x87).toByte()
        return out
    }

    private fun aesEcb(mode: Int, key: ByteArray, data: ByteArray): ByteArray =
        Cipher.getInstance("AES/ECB/NoPadding").apply { init(mode, SecretKeySpec(key, "AES")) }.doFinal(data)

    private fun aesCbc(key: ByteArray, iv: ByteArray, data: ByteArray): ByteArray =
        Cipher.getInstance("AES/CBC/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv)) }.doFinal(data)

    private fun pad80(d: ByteArray): ByteArray {
        val out = d.copyOf((d.size / 16 + 1) * 16)
        out[d.size] = 0x80.toByte()
        return out
    }

    private fun unhex(s: String): ByteArray = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
