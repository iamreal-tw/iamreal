package tw.iamreal.app.card

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The card, over the phone's NFC (issue #173): the system's reader mode,
 * which hands the app the card while the app is in front, and nothing else
 * the card might be read by (another app, the system's own handling of a
 * card held to the phone).
 *
 * Reader mode is on only while a tap waits for a card or uses it, and only
 * while the app's screen is in front ([resumed], [paused]): a card held to
 * the phone at any other time is not read. What is sent to the card is in
 * GpkiCard.kt.
 */
internal class NfcCard(private val adapter: NfcAdapter?) : Card, ReadsInFront {
    private val main = Handler(Looper.getMainLooper())

    /** The screen in front, on the main thread only. */
    private var front: Activity? = null

    /** The tap under way, if any. */
    @Volatile private var waiting: Waiting? = null

    private class Waiting {
        /** A [Tag], or [GIVEN_UP]. */
        val handed = LinkedBlockingQueue<Any>()

        /** The tap is done with the card. */
        val done = CountDownLatch(1)
    }

    /** The app's screen came to the front. On the main thread. */
    override fun resumed(activity: Activity) {
        front = activity
        if (waiting != null) enable()
    }

    /** The app's screen left the front: no card is read until it is back. On the main thread. */
    override fun paused(activity: Activity) {
        if (front !== activity) return
        disable()
        front = null
    }

    override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T {
        val nfc = adapter ?: throw CardException(CardException.Reason.NO_NFC)
        if (!nfc.isEnabled) throw CardException(CardException.Reason.NFC_OFF)
        val w = Waiting()
        cancel.onCancel { w.handed.offer(GIVEN_UP) }
        waiting = w
        main.post { if (waiting === w) enable() }
        try {
            val tag = when (val handed = w.handed.poll(WAIT_MS, TimeUnit.MILLISECONDS)) {
                null -> throw CardException(CardException.Reason.NO_TAP)
                GIVEN_UP -> throw CardException(CardException.Reason.CANCELLED)
                else -> handed as Tag
            }
            // A card that speaks no ISO 14443-4 is no citizen digital certificate.
            val iso = IsoDep.get(tag) ?: throw CardException(CardException.Reason.OTHER)
            try {
                try {
                    iso.connect()
                    iso.timeout = COMMAND_MS
                } catch (e: IOException) {
                    throw CardException(CardException.Reason.DROPPED)
                } catch (e: SecurityException) {
                    // The system says the tag is out of date: the card left and came back.
                    throw CardException(CardException.Reason.DROPPED)
                } catch (e: IllegalStateException) {
                    throw CardException(CardException.Reason.DROPPED)
                } catch (e: UnsupportedOperationException) {
                    // NFC was turned off under the tap.
                    throw CardException(CardException.Reason.DROPPED)
                }
                return GpkiCard(transceive(iso), cancel).use { card -> use(card) }
            } finally {
                try {
                    iso.close()
                } catch (e: Exception) {
                    // The card, or NFC, is gone already: what ended the tap is what it says.
                }
            }
        } finally {
            waiting = null
            w.done.countDown()
            main.post { if (waiting == null) disable() }
        }
    }

    /** A card gone in the middle of a command, whatever the system calls it, is a card that left. */
    private fun transceive(iso: IsoDep): (ByteArray) -> ByteArray = { command ->
        try {
            iso.transceive(command)
        } catch (e: SecurityException) {
            // The system says the tag is out of date: it left and came back, or another was held.
            throw IOException(e)
        } catch (e: IllegalStateException) {
            throw IOException(e)
        }
    }

    /** Called by the system on a thread of its own when a card is held to the phone; kept until the tap is done with it. */
    private fun discovered(tag: Tag) {
        val w = waiting ?: return
        w.handed.offer(tag)
        w.done.await()
    }

    private fun enable() {
        val activity = front ?: return
        val extras = Bundle().apply {
            // The system's own check that the card is still there, between the app's commands: not too often.
            putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_MS)
        }
        adapter?.enableReaderMode(activity, { tag -> discovered(tag) }, NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK, extras)
    }

    private fun disable() {
        val activity = front ?: return
        adapter?.disableReaderMode(activity)
    }

    private companion object {
        val GIVEN_UP = Any()

        /** How long a tap waits for a card before it ends as one where none came. */
        const val WAIT_MS = 60_000L

        /** How long one command may take the card. Signing takes it about a second. */
        const val COMMAND_MS = 10_000

        const val PRESENCE_CHECK_MS = 5_000
    }
}
