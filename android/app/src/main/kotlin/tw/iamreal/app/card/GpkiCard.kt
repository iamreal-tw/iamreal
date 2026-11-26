// Source: the commands to the card and how its PKCS#15 files are read are from GpkiCard.kt of mctea01/my-Bonds-fork-android (Apache-2.0), commit a8696253: https://github.com/mctea01/my-Bonds-fork-android/blob/a8696253a4c4be6c88a3618fded4c716b13f72fa/core/src/commonMain/kotlin/diw/wallet/core/document/card/GpkiCard.kt
package tw.iamreal.app.card

import java.io.IOException
import java.security.SecureRandom

/**
 * A second-generation citizen digital certificate held to the phone, for one
 * tap: the commands the app sends it. [transceive] sends one command and
 * returns the card's whole answer (data and status word); it throws
 * [IOException] when the card left.
 *
 * [readCertificates] reads the certificates without the PIN, then opens the
 * secure channel and has the card take one encrypted command: a card the
 * app cannot sign with stops there, before anyone types a PIN for it.
 * [sign] then sends the PIN once, in the channel. Any answer to the PIN
 * other than success stops the tap; nothing is sent again by itself.
 *
 * Every command first looks at [cancel]: a tap given up ends at the next
 * command, never in the middle of one.
 */
internal class GpkiCard(private val transceive: (ByteArray) -> ByteArray, private val cancel: TapCancel) : CardConnection, AutoCloseable {
    private var session: SecureChannel.Session? = null
    private var keyRef = -1

    /** [readCertificates] went to its end on this connection: the channel works. */
    private var ready = false

    /** The card answered the PIN of [sign] with 9000. */
    override var pinAccepted = false
        private set

    override fun readCertificates(): List<ByteArray> {
        ready = false
        connect()
        val keys = Der.records(readDirectory(PRKDF)).mapNotNull { parseKey(it) }
        val certificates = Der.records(readDirectory(CDF)).mapNotNull { parseCert(it) }.mapNotNull { path ->
            selectPath(path.path)
            Der.firstObject(readRange(path.index, if (path.length > 0) path.length else 4096))
        }
        if (certificates.isEmpty()) return certificates
        val key = keys.filter { it.canSign }.let { s -> s.firstOrNull { it.id.contentEquals(SIGN_ID) || it.label.contains("SIGN", true) } ?: s.firstOrNull() }
            ?: keys.firstOrNull()
            ?: fail(CardException.Reason.OTHER)
        keyRef = key.keyRef
        openChannel()
        // Encrypted commands the card takes before the PIN goes: a channel that is wrong costs no try of the PIN.
        smSelect(CARD_DF, CardException.Reason.CHANNEL)
        smSelect(KEY_EF, CardException.Reason.CHANNEL)
        ready = true
        return certificates
    }

    /** Only after [readCertificates] went to its end on this connection: the caller compares the certificates before the PIN goes. */
    override fun sign(message: ByteArray, pin: ByteArray): ByteArray {
        if (!ready) fail(CardException.Reason.OTHER)
        val s = session ?: fail(CardException.Reason.OTHER)
        // A PIN no card takes is not sent: it would only cost a try.
        val block = SecureChannel.pinBlock(pin) ?: fail(CardException.Reason.PIN_INCORRECT)
        val wrapped = try {
            s.wrap(0x00, 0x20, 0x00, 0x01, block, true)
        } finally {
            block.fill(0)
        }
        // Sent once as it is, whatever the card answers: no 6CXX, no GET RESPONSE. A card that left on the way may have taken it.
        val verify = send(apdu(wrapped.header[0].toInt() and 0xFF, 0x20, 0x00, 0x01, wrapped.body, 0), CardException.Reason.PIN_MAYBE_SENT)
        when {
            verify.sw == 0x9000 -> pinAccepted = true
            verify.sw == 0x6983 || verify.sw == 0x63C0 -> fail(CardException.Reason.LOCKED)
            verify.sw and 0xFFF0 == 0x63C0 -> fail(CardException.Reason.PIN_INCORRECT)
            else -> fail(CardException.Reason.OTHER)
        }
        smSelect(CARD_DF, CardException.Reason.OTHER)
        smSelect(KEY_EF, CardException.Reason.OTHER)
        val toSign = SecureChannel.signBlock(message)
        var out = ByteArray(0)
        for (i in 0 until 2) {
            val more = i == 0
            val r = sm(0x80, 0xEA, if (more) 0x82 else 0x02, keyRef, toSign.copyOfRange(i * 128, i * 128 + 128), if (more) 0 else 0x80, true)
            if (!r.ok) fail(CardException.Reason.OTHER)
            out += r.data
        }
        var guard = 0
        while (out.size < RSA_LEN && guard++ < 4) {
            val r = sm(0x80, 0xC1, 0x00, 0x80, ByteArray(0), 0x80, false)
            if (!r.ok || r.data.isEmpty()) fail(CardException.Reason.OTHER)
            out += r.data
        }
        if (out.size < RSA_LEN) fail(CardException.Reason.OTHER)
        return out.copyOf(RSA_LEN)
    }

    /** Overwrites the session's keys. */
    override fun close() {
        session?.wipe()
        session = null
    }

    // The card's applications --------------------------------------------------------------

    /**
     * Selects the signing application. A card without it that has the first generation's master file and its
     * DF 5030 says it is a first-generation card; any other card is no citizen digital certificate.
     */
    private fun connect() {
        if (selectsApplication()) return
        for (cla in listOf(0x80, 0x00)) {
            if (transmit(cla, 0xA4, 0x00, 0x00, fid(0x3F00), 0).ok && transmit(cla, 0xA4, 0x00, 0x00, fid(CARD_DF), 0).accepted) {
                fail(CardException.Reason.FIRST_GENERATION)
            }
        }
        fail(CardException.Reason.OTHER)
    }

    private fun selectsApplication(): Boolean = transmit(0x00, 0xA4, 0x04, 0x0C, SecureChannel.GPPKI_AID, 256).ok

    /** The signing application, whose files are read below it: what a second-generation card has in the place of a master file. */
    private fun selectApplication() {
        if (!selectsApplication()) fail(CardException.Reason.OTHER)
    }

    private fun selectFid(fid: Int): Boolean = transmit(0x00, 0xA4, 0x00, 0x04, fid(fid), 256).accepted

    private fun selectPath(path: ByteArray) {
        var i = 0
        selectApplication()
        if (path.size >= 2 && path[0] == 0x3F.toByte() && path[1] == 0x00.toByte()) {
            i = 2
        } else if (path.size <= 2 && !selectFid(CARD_DF)) {
            fail(CardException.Reason.OTHER)
        }
        while (i + 1 < path.size) {
            val f = ((path[i].toInt() and 0xFF) shl 8) or (path[i + 1].toInt() and 0xFF)
            if (f == 0x7FFF) selectApplication() else if (!selectFid(f)) fail(CardException.Reason.OTHER)
            i += 2
        }
    }

    private fun readBinary(offset: Int, want: Int): ByteArray? {
        var w = want
        while (true) {
            val r = transmit(0x00, 0xB0, (offset shr 8) and 0x7F, offset and 0xFF, ByteArray(0), w)
            if (r.sw == 0x6987 && w > 16) {
                w = 16
                continue
            }
            return if (r.accepted) r.data else null
        }
    }

    private fun readRange(offset: Int, length: Int): ByteArray {
        var out = ByteArray(0)
        var off = offset
        while (out.size < length) {
            val want = minOf(CHUNK, length - out.size)
            val got = readBinary(off, want) ?: break
            if (got.isEmpty()) break
            out += got
            off += got.size
            if (got.size < want) break
        }
        return out
    }

    /** A PKCS#15 directory file under DF 5030, up to the padding after its last record. */
    private fun readDirectory(f: Int): ByteArray {
        selectApplication()
        if (!selectFid(CARD_DF) || !selectFid(f)) return ByteArray(0)
        var buf = ByteArray(0)
        var off = 0
        while (buf.size < 16 * 1024) {
            val got = readBinary(off, CHUNK) ?: break
            if (got.isEmpty()) break
            buf += got
            off += got.size
            Der.recordsEnd(buf)?.let { return buf.copyOf(it) }
            if (got.size < CHUNK) break
        }
        return buf
    }

    // The secure channel -------------------------------------------------------------------

    /** The card's static keys, a session, and EXTERNAL AUTHENTICATE only when the card's cryptogram is the expected one. */
    private fun openChannel() {
        close()
        if (!transmit(0x00, 0xA4, 0x04, 0x00, SecureChannel.ISD_CM_AID, 0).accepted) fail(CardException.Reason.CHANNEL)
        val keyInformation = transmit(0x80, 0xCA, 0x00, 0xE0, ByteArray(0), 256)
        if (!keyInformation.ok || !SecureChannel.keyInformationAccepted(keyInformation.data)) fail(CardException.Reason.CHANNEL)
        if (!transmit(0x00, 0xA4, 0x04, 0x00, SecureChannel.ISD_AID, 0).accepted) fail(CardException.Reason.CHANNEL)
        val tag45 = transmit(0x80, 0xCA, 0x00, 0x45, ByteArray(0), 256)
        val cardId = (if (tag45.ok) SecureChannel.cardId(tag45.data) else null) ?: fail(CardException.Reason.CHANNEL)
        val keys = SecureChannel.diversify(cardId)
        try {
            if (!selectsApplication()) fail(CardException.Reason.CHANNEL)
            val host = ByteArray(8).also { SecureRandom().nextBytes(it) }
            val update = transmit(0x80, 0x50, 0x01, 0x00, host, 256)
            val card = (if (update.ok) SecureChannel.InitializeUpdate.of(update.data) else null) ?: fail(CardException.Reason.CHANNEL)
            // Not the card the key material is for: nothing is sent back to it.
            val opened = SecureChannel.Session.open(keys, host, card) ?: fail(CardException.Reason.CHANNEL)
            try {
                val authenticate = opened.externalAuthenticate
                if (!transmit(authenticate.header[0].toInt() and 0xFF, 0x82, 0x03, 0x00, authenticate.body, 0).ok) fail(CardException.Reason.CHANNEL)
            } catch (e: CardException) {
                // The card left, the tap was given up, or the card refused: the session's keys go with it.
                opened.session.wipe()
                throw e
            }
            session = opened.session
        } finally {
            keys.wipe()
        }
    }

    private fun sm(cla: Int, ins: Int, p1: Int, p2: Int, data: ByteArray, le: Int, encrypt: Boolean): Response {
        val s = session ?: fail(CardException.Reason.CHANNEL)
        val w = s.wrap(cla, ins, p1, p2, data, encrypt)
        return transmit(w.header[0].toInt() and 0xFF, ins, p1, p2, w.body, le)
    }

    private fun smSelect(f: Int, refused: CardException.Reason) {
        if (!sm(0x00, 0xA4, 0x00, 0x04, fid(f), 0, true).accepted) fail(refused)
    }

    // Commands -----------------------------------------------------------------------------

    private class Response(val sw: Int, val data: ByteArray) {
        val ok: Boolean get() = sw == 0x9000
        val warning: Boolean get() = sw and 0xFF00 == 0x6200

        /** The length a 61XX or 6CXX says is there: XX, 00 being 256. */
        val lengthAvailable: Int get() = (sw and 0xFF).let { if (it == 0) 256 else it }

        /** Done, or done with a warning. */
        val accepted: Boolean get() = ok || warning
    }

    /** A short command; [le] 0 is none, 256 is `00`. Takes 61XX with GET RESPONSE and 6CXX by sending again with that Le. */
    private fun transmit(cla: Int, ins: Int, p1: Int, p2: Int, data: ByteArray, le: Int): Response {
        var r = send(apdu(cla, ins, p1, p2, data, le), CardException.Reason.DROPPED)
        if (r.sw shr 8 == 0x6C) r = send(apdu(cla, ins, p1, p2, data, r.lengthAvailable), CardException.Reason.DROPPED)
        var out = r.data
        var guard = 0
        while (r.sw shr 8 == 0x61 && guard++ < 32) {
            r = send(apdu(0x00, 0xC0, 0x00, 0x00, ByteArray(0), r.lengthAvailable), CardException.Reason.DROPPED)
            out += r.data
        }
        return Response(r.sw, out)
    }

    private fun send(command: ByteArray, whenLost: CardException.Reason): Response {
        if (cancel.isCancelled) fail(CardException.Reason.CANCELLED)
        val answer = try {
            transceive(command)
        } catch (e: IOException) {
            fail(whenLost)
        } finally {
            command.fill(0)
        }
        if (answer.size < 2) fail(CardException.Reason.OTHER)
        return Response(((answer[answer.size - 2].toInt() and 0xFF) shl 8) or (answer[answer.size - 1].toInt() and 0xFF), answer.copyOf(answer.size - 2))
    }

    private fun apdu(cla: Int, ins: Int, p1: Int, p2: Int, data: ByteArray, le: Int): ByteArray {
        val head = byteArrayOf(cla.toByte(), ins.toByte(), p1.toByte(), p2.toByte())
        val lc = if (data.isNotEmpty()) byteArrayOf(data.size.toByte()) else ByteArray(0)
        val tail = if (le > 0) byteArrayOf((if (le == 256) 0 else le).toByte()) else ByteArray(0)
        return head + lc + data + tail
    }

    private fun fail(reason: CardException.Reason): Nothing = throw CardException(reason)

    private fun fid(f: Int) = byteArrayOf((f shr 8).toByte(), f.toByte())

    // PKCS#15 ------------------------------------------------------------------------------

    private class Path(val path: ByteArray, val index: Int, val length: Int)

    private class Key(val label: String, val id: ByteArray, val keyRef: Int, val canSign: Boolean)

    private fun parseKey(entry: Der.Tlv): Key? {
        val parts = Der.children(entry.value)
        if (parts.size < 2) return null
        val label = Der.children(parts[0].value).firstOrNull { it.tag in setOf(0x0C, 0x13, 0x16) }?.value?.decodeToString()?.trim { it.code == 0 || it.code == 0xFF || it.isWhitespace() }.orEmpty()
        var id = ByteArray(0)
        var usage = 0
        var keyRef = -1
        for (el in Der.children(parts[1].value)) when (el.tag) {
            0x04 -> if (id.isEmpty()) id = el.value
            0x03 -> usage = Der.bits(el.value)
            0x02 -> if (keyRef < 0) keyRef = Der.uint(el.value)
        }
        if (keyRef < 0) {
            // Some cards keep the key reference in the class attributes ([0]) or the type attributes.
            keyRef = parts.drop(2).firstNotNullOfOrNull { p -> Der.findInteger(p.value) { it in 0..255 } } ?: return null
        }
        val canSign = usage and ((1 shl 2) or (1 shl 3) or (1 shl 9)) != 0
        return Key(label, id, keyRef, canSign)
    }

    private fun parseCert(entry: Der.Tlv): Path? {
        val parts = Der.children(entry.value)
        if (parts.size < 3) return null
        val inner = Der.children(parts[2].value).firstOrNull() ?: return null
        val pathSeq = Der.children(inner.value).firstOrNull() ?: return null
        return parsePath(pathSeq)
    }

    private fun parsePath(t: Der.Tlv): Path? {
        if (t.tag != 0x30) return null
        val els = Der.children(t.value)
        val first = els.firstOrNull() ?: return null
        if (first.tag == 0x30) return parsePath(first)
        if (first.tag != 0x04 || first.value.isEmpty()) return null
        var index = 0
        var length = 0
        for (e in els.drop(1)) when (e.tag) {
            0x02 -> index = Der.uint(e.value)
            0x80 -> length = Der.uint(e.value)
        }
        return Path(first.value, index, length)
    }

    private companion object {
        const val CHUNK = 0xC8
        const val RSA_LEN = 256
        const val CARD_DF = 0x5030
        const val KEY_EF = 0x0810
        const val PRKDF = 0x4100
        const val CDF = 0x4104
        val SIGN_ID = "SIGN".encodeToByteArray()
    }
}

/** Minimal DER reading for PKCS#15 directory files. */
internal object Der {
    class Tlv(val tag: Int, val value: ByteArray, val headerLength: Int) {
        val totalLength get() = headerLength + value.size
    }

    fun read(b: ByteArray, off: Int): Tlv? {
        if (off + 2 > b.size) return null
        var p = off
        val tag = b[p++].toInt() and 0xFF
        if (tag and 0x1F == 0x1F) return null
        var len = b[p++].toInt() and 0xFF
        if (len and 0x80 != 0) {
            val n = len and 0x7F
            if (n == 0 || n > 3 || p + n > b.size) return null
            len = 0
            repeat(n) { len = (len shl 8) or (b[p++].toInt() and 0xFF) }
        }
        if (p + len > b.size) return null
        return Tlv(tag, b.copyOfRange(p, p + len), p - off)
    }

    fun children(b: ByteArray): List<Tlv> {
        val out = ArrayList<Tlv>()
        var off = 0
        while (off < b.size) {
            val t = read(b, off) ?: break
            out.add(t)
            off += t.totalLength
        }
        return out
    }

    /** Top-level SEQUENCE records until padding (00 or FF). */
    fun records(b: ByteArray): List<Tlv> {
        val out = ArrayList<Tlv>()
        var off = 0
        while (off < b.size && b[off] != 0.toByte() && b[off] != 0xFF.toByte()) {
            val t = read(b, off) ?: break
            if (t.tag == 0x30) out.add(t)
            off += t.totalLength
        }
        return out
    }

    fun recordsEnd(b: ByteArray): Int? {
        var off = 0
        while (off < b.size) {
            if (b[off] == 0.toByte() || b[off] == 0xFF.toByte()) return off
            val t = read(b, off) ?: return null
            off += t.totalLength
        }
        return null
    }

    fun firstObject(b: ByteArray): ByteArray? = read(b, 0)?.let { b.copyOf(it.totalLength) }

    fun uint(v: ByteArray): Int = v.takeLast(4).fold(0) { a, x -> (a shl 8) or (x.toInt() and 0xFF) }

    /** BIT STRING flags with bit 0 being the first named bit. */
    fun bits(v: ByteArray): Int {
        var bits = 0
        for (i in 1 until minOf(v.size, 5)) for (j in 0 until 8) if (v[i].toInt() and (0x80 shr j) != 0) bits = bits or (1 shl ((i - 1) * 8 + j))
        return bits
    }

    /** The first INTEGER in a nested structure that satisfies [accept]. */
    fun findInteger(b: ByteArray, accept: (Int) -> Boolean): Int? {
        for (t in children(b)) {
            if (t.tag == 0x02) {
                val v = uint(t.value)
                if (accept(v)) return v
            }
            if (t.tag and 0x20 != 0) findInteger(t.value, accept)?.let { return it }
        }
        return null
    }
}
