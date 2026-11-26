package tw.iamreal.app.flow

import org.json.JSONObject
import tw.iamreal.app.card.CardException
import tw.iamreal.app.core.DeviceCore
import tw.iamreal.app.core.DeviceCoreException

/**
 * The counts of the app's card proofs (spec/counts.md; ADR-0032, ADR-0039): which step a card proof reached, why it
 * stopped or must be tried again, a card that left during a tap, how long the CRL, the tree and the proof took. One
 * request to `POST /api/v1/counts` for each, whose answer nobody reads.
 *
 * - Every value is a code of the table, chosen here ([reasonOf]), or a random ID, or one of three values of the phone's
 *   system: its version, the app's version, the phone's model ([Deps]). The core builds the body ([DeviceCore.count]) by
 *   the table the server reads with: a version or a model not in its format is left out, and a count the server would
 *   drop is not sent. Nothing of a failure but its code: no text of an exception, the card or the server. No account, no
 *   scoped ID, nothing read from the card.
 * - The card proof device ID is 16 random bytes kept in the app's own preferences with the date it was made on, in
 *   Taiwan; 31 days after that date it is replaced, and the old one is not kept anywhere ([deviceId], the core's rule). The submission of
 *   a record carries it too. The attempt ID is 16 random bytes kept in memory by one card proof ([Attempt]), and dropped
 *   with it.
 * - Sending never holds a card proof up: [Deps.send] does not wait, and a request that fails is not sent again.
 */
class Counts(private val deps: Deps) {
    interface Deps {
        /** Sends [body] to `POST /api/v1/counts`, off the calling thread; one that fails is not sent again, and is nobody's failure. */
        fun send(body: ByteArray)

        /** The phone's clock, in milliseconds since 1970. */
        fun now(): Long

        /** Fills [bytes] from the phone's random source. */
        fun random(bytes: ByteArray)

        /** Where the card proof device ID is kept: `<ID>.<the date it was made on>`. */
        val store: Store

        /** `android` or `ios` (spec/counts.md, "Clients"). */
        val client: String

        /** The system's version as it gives it (`Build.VERSION.RELEASE`). */
        val osVersion: String

        /** The version the store shows (`versionName`). */
        val appVersion: String

        /** The phone's model as its system gives it (`Build.MODEL`), never a name its owner gave it. */
        val model: String
    }

    /** One value of the app's own preferences. */
    interface Store {
        fun get(): String?

        fun set(value: String)
    }

    /**
     * The card proof device ID today, by the core's rule (spec/counts.md, "The card proof device ID"): the stored one if it
     * was made fewer than 31 days ago in Taiwan, otherwise a new one, written over the old. Throws [DeviceCoreException]
     * for a clock the core does not take.
     */
    @Synchronized
    fun deviceId(): String {
        val random = ByteArray(16).also(deps::random)
        val answer = JSONObject(String(DeviceCore.countDeviceId((deps.store.get() ?: "").toByteArray(), deps.now() / 1000, random), Charsets.UTF_8))
        random.fill(0)
        if (!answer.isNull("store")) deps.store.set(answer.getString("store"))
        return answer.getString("device_id")
    }

    private fun newId(): String {
        val bytes = ByteArray(16)
        deps.random(bytes)
        return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** The card proof device ID, or null when none can be had (a clock the core does not take, no preferences). */
    fun deviceIdOrNull(): String? = try {
        deviceId()
    } catch (e: RuntimeException) {
        null
    }

    /** The counts of one card proof, under a new attempt ID. */
    fun attempt(): Attempt = Attempt(newId())

    /**
     * The counts of one card proof. Each step is sent once; after a stop, nothing more is: the card proof is over. Any
     * thread may call; nothing here waits for the server, and nothing here throws.
     */
    inner class Attempt internal constructor(private val id: String) {
        private val reached = mutableSetOf<String>()
        private var stopped = false

        /** A card was asked to be read for this card proof, or it stopped: a card proof after it is another one. */
        val begun: Boolean
            @Synchronized get() = stopped || "read" in reached

        /** The card proof reached [step]. */
        @Synchronized
        fun step(step: String) {
            if (stopped || !reached.add(step)) return
            send("event" to "step", "step" to step)
        }

        /** The card proof stopped, and is over. */
        @Synchronized
        fun stop(reason: String) {
            if (stopped) return
            stopped = true
            sendReason("stop", reason)
        }

        /** A step did not pass and can be tried again; the card proof goes on. */
        @Synchronized
        fun retry(reason: String) {
            if (!stopped) sendReason("retry", reason)
        }

        /** The card left the phone during tap [tap] (1, 2 or 3). */
        @Synchronized
        fun tapDropped(tap: Int) {
            if (!stopped) send("event" to "action", "action" to "tap_dropped", "tap" to tap.toString())
        }

        /** The timed step [step] (`crl`, `tree`, `proved`) took [ms] milliseconds. */
        @Synchronized
        fun took(step: String, ms: Long) {
            if (stopped) return
            val took = try {
                DeviceCore.countTook(ms)
            } catch (e: DeviceCoreException) {
                return
            }
            send("event" to "duration", "step" to step, "took" to took)
        }

        /** A code of the server's the table has no reason for is `server_other` (spec/counts.md, "Reasons"). */
        private fun sendReason(event: String, reason: String) {
            if (!send("event" to event, "reason" to reason) && reason.startsWith("server_")) send("event" to event, "reason" to "server_other")
        }

        /** False when there is nothing to send: the core says the server would drop it. */
        private fun send(vararg members: Pair<String, String>): Boolean {
            val body = try {
                val count = JSONObject()
                count.put("client", deps.client)
                for ((name, value) in members) count.put(name, value)
                count.put("device_id", deviceId())
                count.put("attempt_id", id)
                count.put("os_version", deps.osVersion)
                count.put("app_version", deps.appVersion)
                count.put("model", deps.model)
                DeviceCore.count(count.toString().toByteArray())
            } catch (e: DeviceCoreException) {
                return false
            } catch (e: RuntimeException) {
                // A count that cannot be made (no random source, no preferences) is not sent; the card proof goes on.
                return false
            }
            try {
                deps.send(body)
            } catch (e: RuntimeException) {
                // Not sent: nobody's failure.
            }
            return true
        }
    }

    companion object {
        /**
         * The reason code of [stop] (spec/counts.md, "Reasons"), chosen by its own codes and by nothing else it holds: not
         * its dates, days, request ID. Null when there is none to count: the cardholder left ([Stop] `cancelled`), or a card
         * that left during a tap, which is an action ([Attempt.tapDropped]).
         */
        fun reasonOf(stop: Stop): String? = when (stop.code) {
            "cancelled" -> null
            "card" -> when (stop.values["reason"]) {
                CardException.Reason.CANCELLED.name -> "tap_cancelled"
                CardException.Reason.NO_TAP.name -> "no_tap"
                CardException.Reason.DROPPED.name -> null
                CardException.Reason.PIN_MAYBE_SENT.name -> "pin_maybe_received"
                CardException.Reason.PIN_INCORRECT.name -> "pin_incorrect"
                CardException.Reason.LOCKED.name -> "card_locked"
                CardException.Reason.NO_NFC.name -> "no_nfc"
                CardException.Reason.NFC_OFF.name -> "nfc_off"
                CardException.Reason.CHANNEL.name -> "channel"
                CardException.Reason.FIRST_GENERATION.name -> "first_generation"
                else -> "card_error"
            }
            "certificate" -> when (stop.values["problem"]) {
                "no_certificate" -> "no_certificate"
                "expired" -> "cert_expired"
                "not_yet_valid" -> "cert_not_yet_valid"
                "not_citizen_primary" -> "cert_not_citizen_primary"
                "unsupported_format" -> "cert_unsupported_format"
                "unknown_issuer" -> "cert_unknown_issuer"
                "ambiguous_certificate" -> "cert_ambiguous"
                else -> "engine"
            }
            // The core's reason codes, which are the table's (crl_unavailable, crl_hash, crl_stale, …).
            "crl" -> stop.values["code"]?.takeIf { it.startsWith("crl_") } ?: "engine"
            "server" -> when (val code = stop.values["code"]) {
                "challenge_malformed" -> "challenge_malformed"
                null -> "server_other"
                else -> "server_$code"
            }
            "date_mismatch" -> "challenge_not_today"
            "min_app" -> "app_too_old"
            "other_card", "revoked", "card_signature", "artifact", "engine", "idle", "date_changed", "clock", "state" -> stop.code
            else -> "state"
        }

        /** The reason code of a list that cannot be signed: the cardholder changes it, and the card proof goes on. */
        fun reasonOf(blocked: Blocked): String = if (blocked.reason == "username") "username" else "blocked_${blocked.reason}"
    }
}
