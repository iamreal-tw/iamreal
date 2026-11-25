package tw.iamreal.app.card

/**
 * The card, as the card proof sees it (issue #133): a card is held to the
 * phone three times, and each time the app first reads its certificates,
 * then, the second and third time, has it sign with the PIN. The card
 * proof compares the certificates with the first tap's before it hands
 * over the PIN, so the two are separate calls on one connection.
 *
 * The app that goes out reads a real card over NFC; the emulator test puts
 * a fake card here (src/fake/). Nothing else in the app talks to a card.
 */
interface Card {
    /**
     * One tap: waits until a card is held to the phone, runs [use] with the connection to it, and returns
     * what [use] returned. It blocks: for a background thread. The connection is of no use after [use]
     * returns. Throws [CardException] when no card came, or the card left before [use] was done; with
     * [CardException.Reason.CANCELLED] when [cancel] was cancelled while it waited for a card, or before.
     */
    fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T
}

/**
 * How one tap is given up from another thread (the panel's 取消, a card proof that ended). It is of one
 * tap only, and it stays cancelled: a tap that begins after [cancel] ends at once.
 */
class TapCancel {
    private var cancelled = false
    private var listener: (() -> Unit)? = null

    val isCancelled: Boolean @Synchronized get() = cancelled

    fun cancel() {
        val tell = synchronized(this) {
            if (cancelled) return
            cancelled = true
            listener
        }
        tell?.invoke()
    }

    /** [f] is called once when the tap is cancelled, on the thread that cancels it; at once if it already is. For the card's own use. */
    fun onCancel(f: () -> Unit) {
        val now = synchronized(this) {
            listener = f
            cancelled
        }
        if (now) f()
    }
}

/** A card held to the phone, for the length of one tap. */
interface CardConnection {
    /** The certificates on the card (DER), in the card's order. No PIN. */
    fun readCertificates(): List<ByteArray>

    /**
     * Verifies [pin] with the card, then has the card's signing key sign [message] (RSASSA-PKCS1-v1_5 with
     * SHA-256): 256 bytes. [pin] stays the caller's, who overwrites it; an implementation keeps no copy.
     */
    fun sign(message: ByteArray, pin: ByteArray): ByteArray
}

/** A tap that did not do what it was for. It carries the reason and nothing read from the card. */
class CardException(val reason: Reason) : Exception(reason.name) {
    enum class Reason {
        /** The tap was given up ([TapCancel]). */
        CANCELLED,

        /** No card was held to the phone. */
        NO_TAP,

        /** The card left the phone before the tap was done. */
        DROPPED,

        /**
         * The card left the phone while the PIN was on its way to it: whether the card took it, and counted a
         * wrong one, is not known. The PIN is not sent again by itself.
         */
        PIN_MAYBE_SENT,

        /** The card says the PIN is not its PIN. */
        PIN_INCORRECT,

        /** The card's PIN is locked. */
        LOCKED,

        /** The phone has no NFC. */
        NO_NFC,

        /** The phone's NFC is turned off. */
        NFC_OFF,

        /** The secure channel the card requires could not be made. No PIN was sent. */
        CHANNEL,

        /** A first-generation card, which the app does not read. Nothing was sent to it but the commands that tell. */
        FIRST_GENERATION,

        /** Anything else the card answered. */
        OTHER,
    }
}
