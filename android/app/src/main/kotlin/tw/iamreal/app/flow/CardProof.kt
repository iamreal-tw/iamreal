package tw.iamreal.app.flow

import org.json.JSONArray
import org.json.JSONObject
import tw.iamreal.app.backend.Backend
import tw.iamreal.app.backend.ServerException
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.CardException
import tw.iamreal.app.card.TapCancel
import tw.iamreal.app.core.DeviceCore
import tw.iamreal.app.core.DeviceCoreException
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import kotlin.concurrent.thread

/**
 * One card proof, without a screen: the order of web/src/flow.ts with the
 * card held to the phone three times (issue #133).
 *
 *   begin()            step 1's 下一步: the server's config, asked with the
 *                      mark of a start; turned away as too many, nothing more
 *   readCard()         the server's config, asked without the mark (the
 *                      start's when that one is turned away as too many);
 *                      tap 1: the certificates, no PIN. The core checks
 *                      them; the CRL is downloaded and checked; the tree is
 *                      built in the background
 *   confirmCard(pin)   tap 2: the same card, then the PIN; the card signs
 *                      the scope string; the card's state
 *   retryCardState()   the card's state again, after the server turned it
 *                      away as too many; nothing signed again
 *   choose(entries)    what the list would do; nothing signed, nothing sent
 *   declare()          the challenge; tap 3: the same card, then the PIN;
 *                      the card signs the declaration code; the PIN is
 *                      dropped; the proof; the submission. After the server
 *                      turned the challenge away as too many, called again
 *   resubmit()         the same record again, after the server turned the
 *                      submission away as too many; nothing signed again
 *   cancel()           drops everything
 *
 * Every check and every computation is the core's (device-core/, through
 * [DeviceCore]); this class asks the card, the server and the core in
 * order. The core refuses a scoped ID before every check has passed, so a
 * step out of order here sends nothing that names the card.
 *
 * Where each secret is:
 *   PIN            from the caller, a copy kept here from tap 2 until tap 3
 *                  has sent it, [cancel], a stop, or [IDLE_MS] after tap 2;
 *                  overwritten then. Never written anywhere
 *   certificate    the chosen one, here (to compare at taps 2 and 3) and in
 *                  the core's session; overwritten at the end
 *   signatures     here until the proof is made; overwritten then
 *   name           returned to the screen by readCard() and kept nowhere
 * Nothing of a card proof under way is written to storage. Stored are the
 * highest CRL number used, per issuer key ([CrlNumbers]), and the card proof
 * device ID ([Counts]).
 *
 * The counts ([Counts]): each step the table names is sent once as it is
 * reached; a stop that ends the card proof as `stop`, one the screen offers
 * to try again as `retry`; a card that left during a tap as an action. The
 * cardholder leaving is not attempt. Nothing waits for them.
 *
 * The steps that wait for a card or a server block: each is called on a
 * background thread, one at a time. [choose] and [inFormat] ask only the
 * core and return at once. [cancel] may be called from any thread: a step
 * under way finds the card proof ended after its next wait and goes no
 * further.
 */
class CardProof(
    private val deps: Deps,
    /**
     * What `config` answered when the cardholder last pressed step 1's 下一步 (`GET /api/v1/config?start`, [begin]), for a card proof
     * that does not begin there (再感應一次卡片): the `config` it asks is not counted against the site-wide limit, and when that one is
     * turned away as too many, the card proof goes on with this one (docs/api/card-proof.md, `config`). Null: none.
     */
    started: ByteArray? = null,
) {
    interface Deps {
        val backend: Backend
        val card: Card

        /**
         * The body of `GET /api/v1/config`. The app asks when it opens and keeps the answer for the card
         * proofs of this run; this waits for it. Throws [ServerException] when the server did not answer.
         */
        fun config(): ByteArray

        /** Opens a session of the core: [DeviceCore.sessionOpen] in the app that goes out. */
        fun openSession(): Long

        /** A file the installer carries (README.md, "內建的檔案"). */
        fun bundled(name: String): ByteArray

        /** The phone's clock, in milliseconds since 1970. */
        fun now(): Long

        /** The app's own build, the `versionCode` (spec/min-app.md). */
        val appBuild: Int

        val crlNumbers: CrlNumbers

        /** The counts of this run of the app: the card proof device ID of the submission. */
        val counts: Counts

        /** This card proof's counts ([Counts.attempt]): the screen may have sent its `open` already. */
        val attempt: Counts.Attempt

        /** A clock that only goes forward, in milliseconds: how long a timed step took. */
        fun elapsed(): Long = System.nanoTime() / 1_000_000
    }

    /** The highest CRL number the phone has used, per issuer key (spec/device-checks.md): stored by the app, with the card proof device ID. */
    interface CrlNumbers {
        fun get(issuer: String): String?

        fun set(issuer: String, number: String)
    }

    /** What the screen is told while a step runs. Called on the step's thread. */
    interface Events {
        /** An item of the list of the step is done. */
        fun done(item: Item) {}

        /** The panel of a tap: what it shows now, or null when it closes. */
        fun tap(panel: Tap?) {}
    }

    enum class Item { SERVER, CARD, CHECK, CRL, CHALLENGE, SIGNED, PROVED }

    enum class Tap { WAITING, READING, SIGNING, READ, SIGNED }

    class CardRead(val name: String)

    /** One row of the card's list as the server reports it. */
    class Slot(
        val platform: String,
        /** False for a platform the app does not know: its account is kept as it is. */
        val known: Boolean,
        val current: String?,
        val lastDeclared: String?,
        val switchCount: Int,
        val switchesLeft: Int,
    )

    class Status(
        val shortId: String,
        /** `YYYY-MM-DD`, or null for a card without a valid record. */
        val lastCardProof: String?,
        /** The days from it to today. */
        val daysSince: Int?,
        val slots: List<Slot>,
        /** The platforms of the server's table the app knows. */
        val tablePlatforms: List<String>,
        /** The server writes no more records of the card today (`card-state`'s `daily_limit`). */
        val dailyLimit: Boolean,
        val today: String,
    )

    /** What a list does on one platform (spec/list-consequence.md, a row). */
    class Row(val platform: String, val known: Boolean, val kind: String, val username: String, val current: String?, val previous: String?, val switchesLeft: Int?)

    class Consequence(
        /** The list the card signs: `platform` and `username`, in order. */
        val accounts: List<Pair<String, String>>,
        val rows: List<Row>,
        val firstRecord: Boolean,
        val today: String,
        /** [rows] as the core wrote them: what it compares the server's answer with ([Answer.of]). */
        internal val rowsJson: ByteArray,
    )

    /** What the server says the record is on one platform: an element of its answer's `kinds`. */
    class Recorded(
        val platform: String,
        val kind: String,
        /** The account: the list's for that platform, or for `withdraw` the one withdrawn. */
        val username: String,
        /** The cards that declare this account once the record is applied; null when the answer has no such count. */
        val accountCards: Long?,
    )

    /**
     * The server's answer to the submission, a `201`, as the core read it (spec/records-response.md). The
     * record is in the proof log whatever the answer holds: what cannot be read is null, never a failure.
     */
    class Answer(
        /** The record's `seq` and hash; both null when nothing of the answer is told. */
        val seq: Long?,
        val recordHash: String?,
        /** The card's ordinal, for the text suggested for sharing; null when it cannot be read, or nothing of the answer is told. */
        val ordinal: Long?,
        /** What the server says the record is on each platform, in ascending order; null when it cannot be read. */
        val kinds: List<Recorded>?,
        /** The platforms on which [kinds] differs from the confirmation screen's rows, in ascending order; empty when [kinds] is null. */
        val mismatches: List<String>,
    ) {
        companion object {
            /** An answer of which nothing is told. */
            val NOTHING = Answer(null, null, null, null, emptyList())

            /**
             * Reads [response], the body of the `201`, against [rowsJson], the rows the confirmation screen
             * showed. The app cannot check the answer; the core only compares.
             */
            fun of(response: ByteArray, rowsJson: ByteArray): Answer {
                // The record is in the proof log: the core failing to read its answer does not undo it.
                return try {
                    read(JSONObject(String(DeviceCore.recordsResponse(response, rowsJson), Charsets.UTF_8)))
                } catch (e: DeviceCoreException) {
                    NOTHING
                } catch (e: org.json.JSONException) {
                    NOTHING
                }
            }

            /** The core's output (the header, idc_records_response). */
            private fun read(read: JSONObject): Answer {
                val kinds = read.optJSONArray("kinds")
                val mismatches = read.getJSONArray("mismatches")
                return Answer(
                    if (read.isNull("seq")) null else read.getLong("seq"),
                    if (read.isNull("record_hash")) null else read.getString("record_hash"),
                    if (read.isNull("ordinal")) null else read.getLong("ordinal"),
                    kinds?.let {
                        (0 until it.length()).map { i ->
                            val k = it.getJSONObject(i)
                            Recorded(k.getString("platform"), k.getString("kind"), k.getString("username"), if (k.isNull("account_cards")) null else k.getLong("account_cards"))
                        }
                    },
                    (0 until mismatches.length()).map { mismatches.getString(it) },
                )
            }
        }
    }

    /**
     * The card proof is in the proof log. [expected] is what the confirmation screen said the list would do;
     * [answer] what the server says it recorded.
     */
    class Done(
        val expected: List<Row>,
        val answer: Answer,
        val firstRecord: Boolean,
        val date: String,
        val shortId: String,
        val accounts: List<Pair<String, String>>,
        /**
         * The last day the card's certificate is valid, its date in Taiwan; null if it could not be read. In
         * memory only, for the reminder's sentence of a card that expires before it (design/copy/card-proof.md,
         * "6. 完成", app); never stored.
         */
        val validUntil: java.time.LocalDate?,
    )

    private var config: ByteArray? = null
    private var startConfig: ByteArray? = started

    /** [begin] has been called. */
    private var begun = false
    private var platformsJson: ByteArray? = null
    private var session = 0L
    private var certificate: ByteArray? = null
    private var certificateIndex = -1
    private var issuer = ""
    private var validUntil: java.time.LocalDate? = null
    private var background: FutureTask<Unit>? = null
    private var pin: ByteArray? = null
    private var scopeSignature: ByteArray? = null
    private var cardState: ByteArray? = null
    private var status: Status? = null
    private var chosen: Consequence? = null
    private var chosenAccountsJson: ByteArray? = null

    /** The server turned the card's state away as too many: [retryCardState] asks again. */
    private var cardStateTurnedAway = false

    /** The record the server turned away as too many, and what [Done] is made of: [resubmit] sends it again. */
    private class Unsent(val record: ByteArray, val shown: Consequence, val challenge: String, val shortId: String)

    private var unsent: Unsent? = null

    @Volatile private var firstSignedAt: Long? = null

    /** This card proof's counts. */
    private val attempt = deps.attempt

    /**
     * The card has accepted this card proof's PIN at some tap, also one that then failed. From then on a card that
     * leaves while the PIN is on its way is a card that left: the PIN is right, and is sent again (issue #133).
     */
    @Volatile private var pinAccepted = false

    @Volatile private var ended = false

    /** The tap under way, to give it up from another thread. */
    @Volatile private var tapCancel: TapCancel? = null

    private fun nowSeconds(): Long = deps.now() / 1000

    /** Today's date in Taiwan by the phone's clock. */
    private fun today(): String = Instant.ofEpochMilli(deps.now()).atOffset(ZoneOffset.ofHours(8)).toLocalDate().toString()

    /** After every wait: a card proof that ended meanwhile goes no further, and keeps nothing. */
    private fun live() {
        if (!ended) return
        drop()
        throw Stop("cancelled")
    }

    /**
     * Stores something the card proof keeps (the session, the certificate, the PIN, a signature): not once
     * it has ended. [cancel] overwrites what is kept under the same lock, so nothing is stored behind it.
     */
    private fun keep(store: () -> Unit) {
        synchronized(this) { if (!ended) return store() }
        live()
    }

    /** Ends the card proof with [stop]: everything is dropped. */
    private fun fail(stop: Stop): Nothing {
        drop()
        throw stop
    }

    /**
     * Runs a step of the card proof, and tells the counts why it stopped: as `stop` if the card proof is over, as `retry`
     * if the screen offers the step again on it.
     */
    private inline fun <T> counting(step: () -> T): T = try {
        step()
    } catch (e: Stop) {
        // A call refused as out of order (`state`) changed nothing, also after the card proof was over: nothing to count.
        if (e.code != "state") Counts.reasonOf(e)?.let { if (ended) attempt.stop(it) else attempt.retry(it) }
        throw e
    }

    /** The card proof is over for [stop], which the screen found ([Counts]): everything is dropped. */
    fun end(stop: Stop) {
        Counts.reasonOf(stop)?.let(attempt::stop)
        cancel()
    }

    /**
     * The minimum app version of [config] at the phone's clock now (spec/min-app.md; ADR-0035: before a PIN is asked for and
     * before a card is tapped). Before each tap: the start date may come while a card proof is on its way.
     */
    private fun checkMinApp(config: ByteArray) {
        when (val verdict = minApp(config, deps.appBuild, deps.now())) {
            is MinApp.TooOld -> fail(Stop("min_app", mapOf("from" to verdict.from)))
            MinApp.Unreadable -> fail(Stop("server", mapOf("code" to "malformed_response")))
            else -> {}
        }
    }

    /** The wait between tap 2 and tap 3 is over ([IDLE_MS]). */
    fun idleExpired(): Boolean = firstSignedAt?.let { deps.now() - it >= IDLE_MS } ?: false

    private fun checkIdle() {
        if (idleExpired()) fail(Stop("idle"))
    }

    // Step 1's 下一步 ------------------------------------------------------------------

    /**
     * The start of the card proof, before a card is read: `config` asked with the mark of a start, the one request of a card
     * proof the server counts against its site-wide limit (docs/api/card-proof.md, `config`; ADR-0026). Turned away as too
     * many (`429`, `503` `busy`), the card proof ends here: no card is read, and step 1 says so. Card proofs stopped
     * (`paused`): the same. No answer, another refusal, or an answer that cannot be read: it goes on, and [readCard] asks
     * again. An answer that can be read is what [readCard] falls back on, and [startedWith] for a card proof that follows this one.
     */
    fun begin() = counting { beginSteps() }

    private fun beginSteps() {
        if (begun || session != 0L || ended) throw Stop("state")
        begun = true
        val answer = try {
            deps.backend.config(start = true)
        } catch (e: ServerException) {
            if (e.tooMany) fail(Stop.server(e))
            null
        }
        live()
        if (answer != null && pausedIn(answer) == true) fail(Stop("server", mapOf("code" to "paused")))
        // Only an answer that can be read is one to fall back on: the reading asks again in any case.
        startConfig = answer?.takeIf { pausedIn(it) != null && RawJson.member(it, "platforms") != null }
    }

    /** What `config` answered at the start ([begin], or the card proof's before it): for the card proof that follows this one. */
    val startedWith: ByteArray? get() = startConfig

    // Tap 1: the certificates, no PIN --------------------------------------------------

    fun readCard(events: Events): CardRead = counting { readCardSteps(events) }

    private fun readCardSteps(events: Events): CardRead {
        if (session != 0L || ended) throw Stop("state")
        attempt.step("read")
        // Asked again without the mark: when it is turned away as too many, the card proof goes on with the start's
        // (docs/api/card-proof.md, `config`; design/copy/card-proof.md, step 1, 人太多的時候). Any other failure ends it:
        // step 2 offers only a new one.
        val config = try {
            deps.config()
        } catch (e: ServerException) {
            if (!e.tooMany) fail(Stop.server(e))
            startConfig ?: fail(Stop.server(e))
        }
        live()
        // Without a platform table there is nothing to offer (docs/api/card-proof.md).
        platformsJson = RawJson.member(config, "platforms") ?: fail(Stop("server", mapOf("code" to "malformed_response")))
        // The maintainer stopped taking card proofs since step 1 asked (docs/api/card-proof.md, `paused`): before the card is read.
        when (pausedIn(config)) {
            true -> fail(Stop("server", mapOf("code" to "paused")))
            null -> fail(Stop("server", mapOf("code" to "malformed_response")))
            false -> {}
        }
        attempt.step("config")
        // The minimum app version (spec/min-app.md), before the card is read: step 1 looked too, at the answer it had.
        checkMinApp(config)
        this.config = config
        events.done(Item.SERVER)

        val certificates = try {
            tap(events, 1) { connection ->
                events.tap(Tap.READING)
                connection.readCertificates().also { events.tap(Tap.READ) }
            }
        } catch (e: Stop) {
            // A tap that did not happen, a card that left, NFC turned off: the same card proof taps again (Model's readButtonAfter).
            if (e.code == "card" && e.values["reason"] !in TAPPED_AGAIN_AT_FIRST) fail(e)
            throw e
        }
        val name: String
        try {
            live()
            attempt.step("certificates")
            events.done(Item.CARD)
            keep { session = deps.openSession() }
            for (c in certificates) DeviceCore.sessionAddCertificate(session, c)
            val checked = answer(DeviceCore.sessionCheckCertificates(session, nowSeconds()))
            if (!checked.getBoolean("ok")) fail(Stop.certificate(checked))
            name = checked.getString("name")
            issuer = checked.getString("issuer")
            validUntil = Stop.certificateDay(checked.optString("not_after"))?.let(java.time.LocalDate::parse)
            certificateIndex = checked.getInt("chosen")
            // Only the chosen certificate is kept, to compare at the next taps.
            keep { certificate = certificates[certificateIndex].copyOf() }
        } catch (e: DeviceCoreException) {
            fail(Stop.core(e))
        } finally {
            for (c in certificates) c.fill(0)
        }
        attempt.step("certificate")
        events.done(Item.CHECK)

        val crlFrom = deps.elapsed()
        try {
            val index = try {
                deps.backend.crlIndex()
            } catch (e: ServerException) {
                fail(Stop("crl", mapOf("code" to "crl_unavailable")))
            }
            live()
            val choice = answer(DeviceCore.sessionChooseCrl(session, index))
            if (!choice.getBoolean("ok")) fail(Stop.crl(choice))
            val crl = try {
                deps.backend.crl(choice.getString("sha256"))
            } catch (e: ServerException) {
                fail(Stop("crl", mapOf("code" to "crl_unavailable")))
            }
            live()
            val checked = answer(DeviceCore.sessionCheckCrl(session, crl, config, deps.crlNumbers.get(issuer)?.toByteArray()))
            // What the phone remembers from now on, whether or not the file passed.
            checked.optString("highest_after").takeIf { !checked.isNull("highest_after") && it.isNotEmpty() }?.let { deps.crlNumbers.set(issuer, it) }
            if (!checked.getBoolean("ok")) fail(if (checked.getString("problem") == "revoked") Stop("revoked") else Stop.crl(checked))
        } catch (e: DeviceCoreException) {
            fail(Stop.core(e))
        }
        attempt.took("crl", deps.elapsed() - crlFrom)
        attempt.step("crl")
        events.done(Item.CRL)

        // The tree and the files of the proof, while the cardholder types the PIN.
        val s = session
        background = FutureTask {
            try {
                val treeFrom = deps.elapsed()
                DeviceCore.sessionBuildTree(s)
                attempt.took("tree", deps.elapsed() - treeFrom)
                attempt.step("tree")
                val files = proofFiles()
                DeviceCore.sessionCheckArtifacts(s, files.circuit, files.verificationKey, files.crsG1, files.crsG2)
                // The files are the ones written into the core, which proves with them.
                attempt.step("circuit")
                attempt.step("engine")
                // Every check that needs no signature has passed.
                attempt.step("checked")
            } catch (e: Exception) {
                // Counted when it fails, as on the web page; step 3 ends the card proof on it when it waits for this.
                if (!ended) attempt.stop(if (e is DeviceCoreException && e.code == DeviceCoreException.INPUT) "artifact" else "engine")
                throw e
            }
        }.also { thread(name = "tree") { it.run() } }
        return CardRead(name)
    }

    /** The four files of a proof for the certificate's issuer key, as the installer carries them (ADR-0035). */
    private class ProofFiles(val circuit: ByteArray, val verificationKey: ByteArray, val crsG1: ByteArray, val crsG2: ByteArray)

    private fun proofFiles(): ProofFiles {
        val circuit = if (issuer == "G2") "card_proof_rs2048" else "card_proof_rs4096"
        return ProofFiles(deps.bundled("$circuit.json"), deps.bundled("$circuit.vk"), deps.bundled(CRS_G1), deps.bundled(CRS_G2))
    }

    /** The certificate is still valid and the CRL not too old on today's date, or the card proof stops. */
    private fun checkDate() {
        val date = answer(DeviceCore.sessionCheckDate(session, nowSeconds()))
        if (!date.getBoolean("ok")) fail(Stop.date(date))
    }

    /** Waits for what [readCard] left running. */
    private fun awaitBackground() {
        try {
            background!!.get()
        } catch (e: ExecutionException) {
            val cause = e.cause
            // The files are not the ones written into the core, or the core failed.
            fail(if (cause is DeviceCoreException && cause.code == DeviceCoreException.INPUT) Stop("artifact") else Stop("engine"))
        }
        live()
    }

    /** Tap [number] (1, 2 or 3). A card that is not there, or left, ends nothing: the screen offers the tap again. */
    private fun <T> tap(events: Events, number: Int, use: (CardConnection) -> T): T {
        val cancel = TapCancel()
        tapCancel = cancel
        // A card proof that ended before the line above gives this tap up here; one that ends after it, through `cancel`.
        live()
        events.tap(Tap.WAITING)
        try {
            return deps.card.tap(cancel, use)
        } catch (e: CardException) {
            // A card that left is an action, not a reason (spec/counts.md, "Actions of a card proof").
            if (e.reason == CardException.Reason.DROPPED) attempt.tapDropped(number)
            throw Stop("card", mapOf("reason" to e.reason.name))
        } finally {
            tapCancel = null
            events.tap(null)
        }
    }

    /**
     * Taps 2 and 3: the card must be the one of tap 1 before it gets the PIN. Then it signs [message].
     * `other_card`, a tap that did not happen and a card that left end nothing; the screen offers the tap again.
     */
    private fun sign(events: Events, number: Int, message: ByteArray, pin: ByteArray): ByteArray = tap(events, number) { connection ->
        events.tap(Tap.READING)
        val read = connection.readCertificates()
        val first = certificate
        val same = first != null && read.getOrNull(certificateIndex)?.contentEquals(first) == true
        for (c in read) c.fill(0)
        live()
        // Not the card that was read: the PIN is not sent.
        if (!same) throw Stop("other_card")
        // The card gets a copy of this tap's own: cancel(), from another thread, overwrites the one kept here,
        // and a card must never be handed a PIN that is half zeros.
        val handed = pin.copyOf()
        try {
            live()
            events.tap(Tap.SIGNING)
            connection.sign(message, handed).also { events.tap(Tap.SIGNED) }
        } catch (e: CardException) {
            // Whether this PIN was ever accepted is looked at before this tap adds to it.
            val accepted = pinAccepted
            throw if (e.reason == CardException.Reason.PIN_MAYBE_SENT && accepted) CardException(CardException.Reason.DROPPED) else e
        } finally {
            if (connection.pinAccepted) pinAccepted = true
            handed.fill(0)
        }
    }

    // Tap 2: the card signs the scope string -------------------------------------------

    /** [pin] stays the caller's, who overwrites it. A PIN the card refuses ends nothing: the screen asks again. */
    fun confirmCard(pin: ByteArray, events: Events): Status = counting { confirmCardSteps(pin, events) }

    private fun confirmCardSteps(pin: ByteArray, events: Events): Status {
        if (session == 0L || background == null || scopeSignature != null || ended) throw Stop("state")
        attempt.step("pin")
        config?.let(::checkMinApp)
        // Nothing is signed, and no request carries the scoped ID, before these pass.
        awaitBackground()
        val signature = try {
            sign(events, 2, DeviceCore.scopeString(), pin)
        } catch (e: Stop) {
            // A locked card takes no PIN, a phone without NFC reads none: the card proof is over (Model's confirmCard).
            if (e.code == "card" && e.values["reason"] in ENDS_AT_SECOND_TAP) fail(e)
            throw e
        }
        try {
            keep {
                this.pin = pin.copyOf()
                scopeSignature = signature
                // The wait for the last tap starts now.
                firstSignedAt = deps.now()
            }
        } catch (e: Stop) {
            signature.fill(0)
            throw e
        }

        return cardStateNow()
    }

    /**
     * The card's state asked again, after the server turned it away as too many ([confirmCard]): the card signed already and
     * the PIN is kept, so nothing is signed again. The wait for the last tap still counts from tap 2.
     */
    fun retryCardState(): Status = counting {
        if (!cardStateTurnedAway || ended) throw Stop("state")
        checkIdle()
        cardStateNow()
    }

    /**
     * The card's state, asked of the server with the scoped ID. Turned away as too many (docs/api/card-proof.md, "Rules for
     * every endpoint"), the card proof does not end: [retryCardState] asks again. Any other failure ends it.
     */
    private fun cardStateNow(): Status {
        cardStateTurnedAway = false
        val signature = scopeSignature ?: throw Stop("cancelled")
        val request: ByteArray
        try {
            checkDate()
            request = DeviceCore.sessionCardStateRequest(session, nowSeconds(), signature)
        } catch (e: DeviceCoreException) {
            // The signature is not this card's over the scope string.
            fail(if (e.code == DeviceCoreException.INPUT) Stop("card_signature") else Stop.core(e))
        }
        attempt.step("scope_signed")
        val answer = try {
            deps.backend.cardState(request)
        } catch (e: ServerException) {
            live()
            if (!e.tooMany) fail(Stop.server(e))
            checkIdle()
            keep { cardStateTurnedAway = true }
            throw Stop.server(e)
        }
        live()
        checkIdle()
        val today = today()
        // The core reads the two answers by spec/list-consequence.md and says what step 4 shows: what it
        // cannot read, the app does not show.
        val status = try {
            readStatus(DeviceCore.cardStatus(platformsJson!!, answer, Platforms.knownJson, nowSeconds()), shortIdOf(request), today)
        } catch (e: DeviceCoreException) {
            fail(Stop("server", mapOf("code" to "malformed_response")))
        }
        keep {
            cardState = answer
            this.status = status
        }
        attempt.step("state")
        return status
    }

    /** The card's state as step 4 shows it, from the core's answer (`idc_card_status`). */
    private fun readStatus(answer: ByteArray, shortId: String, today: String): Status {
        val status = answer(answer)
        val rows = status.getJSONArray("rows")
        val known = status.getJSONArray("known_platforms")
        val slots = (0 until rows.length()).map {
            val row = rows.getJSONObject(it)
            val current = if (row.isNull("current")) null else row.getString("current")
            if (row.getBoolean("known")) {
                Slot(
                    row.getString("platform"), true, current,
                    if (row.isNull("last_declared")) null else row.getString("last_declared"),
                    row.getInt("switch_count"), row.getInt("switches_left"),
                )
            } else {
                // An account on a platform the app does not know: kept as it is.
                Slot(row.getString("platform"), false, current, current, 0, 0)
            }
        }
        return Status(
            shortId,
            if (status.isNull("last_card_proof")) null else status.getString("last_card_proof"),
            // A date of the server's that is later than the phone's is shown as today.
            if (status.isNull("days_since")) null else maxOf(0, status.getInt("days_since")),
            slots,
            (0 until known.length()).map { known.getString(it) },
            status.getBoolean("daily_limit"),
            today,
        )
    }

    // The cardholder edits the list ----------------------------------------------------

    /**
     * What the list would do. [entries] has, for every platform the screen offers, the account typed (tidied
     * by its [Presentation]) or "" for none. Throws [Blocked] for a list that cannot be signed: the
     * cardholder changes it. Nothing is signed, nothing is sent.
     */
    fun choose(entries: Map<String, String>): Consequence {
        if (status == null || ended) throw Stop("state")
        val consequence = counting {
            checkIdle()
            try {
                consequenceOf(entries)
            } catch (e: Blocked) {
                // The cardholder changes the list: the card proof goes on.
                attempt.retry(Counts.reasonOf(e))
                throw e
            }
        }
        chosen = consequence
        // The list the card signs, as the core takes it.
        chosenAccountsJson = accountsJson(consequence.accounts.toMap())
        attempt.step("chosen")
        return consequence
    }

    /** Whether [username] is in the format of [platform], by the core's reading of the server's table: for "預覽". */
    fun inFormat(platform: String, username: String): Boolean {
        if (status == null || ended) throw Stop("state")
        return try {
            consequenceOf(mapOf(platform to username))
            true
        } catch (e: Blocked) {
            e.reason != "username"
        }
    }

    private fun consequenceOf(entries: Map<String, String>): Consequence {
        val list = entries.filterValues { it.isNotEmpty() }
        val bytes = try {
            DeviceCore.listConsequence(platformsJson!!, cardState!!, Platforms.knownJson, accountsJson(list), nowSeconds())
        } catch (e: DeviceCoreException) {
            fail(Stop.core(e))
        }
        val result = answer(bytes)
        if (!result.getBoolean("valid")) throw Blocked(result.getString("reason"), result.optString("platform").takeIf { it.isNotEmpty() })
        val accounts = result.getJSONArray("accounts")
        val rows = result.getJSONArray("rows")
        return Consequence(
            (0 until accounts.length()).map { accounts.getJSONObject(it).let { a -> a.getString("platform") to a.getString("username") } },
            (0 until rows.length()).map {
                val r = rows.getJSONObject(it)
                Row(
                    r.getString("platform"), r.getBoolean("known"), r.getString("kind"), r.getString("username"),
                    if (r.isNull("current")) null else r.getString("current"),
                    if (r.isNull("previous")) null else r.getString("previous"),
                    if (r.isNull("switches_left")) null else r.getInt("switches_left"),
                )
            },
            result.getBoolean("first_record"),
            today(),
            // The core's own words, cut out as they are; a list that is valid has rows.
            RawJson.member(bytes, "rows") ?: fail(Stop("engine")),
        )
    }

    /** The cardholder's list as the core takes it: in ascending order of platform. */
    private fun accountsJson(list: Map<String, String>): ByteArray =
        JSONArray(list.toSortedMap().map { (platform, username) -> JSONObject().put("platform", platform).put("username", username) }).toString().toByteArray()

    // Tap 3: the card signs the declaration code; the proof; the submission ------------

    fun declare(events: Events): Done = counting { declareSteps(events) }

    private fun declareSteps(events: Events): Done {
        val shown = chosen
        if (shown == null || ended) throw Stop("state")
        attempt.step("confirmed")
        checkIdle()
        config?.let(::checkMinApp)
        // What the list does is not worked out again after midnight: since version 3 of the record rules (ADR-0018)
        // no event rule reads the date, and a new day only lifts the day's limit.
        val accounts = chosenAccountsJson ?: throw Stop("cancelled")
        val challenge: String
        val code: ByteArray
        try {
            // The certificate and the CRL again, on today's date: the card may have been read before midnight.
            checkDate()
            challenge = try {
                deps.backend.challenge()
            } catch (e: ServerException) {
                live()
                // Too many people: nothing was signed, the PIN is kept. Called again, this asks for a challenge again; the wait for
                // the last tap still counts from tap 2.
                if (e.tooMany) throw Stop.server(e)
                fail(Stop.server(e))
            }
            live()
            // In its one spelling and dated today by the phone's clock: the record is dated the challenge's date.
            // Midnight may have passed while the server answered: the core checks the date conditions again then.
            val taken = answer(DeviceCore.sessionCheckChallenge(session, nowSeconds(), challenge.toByteArray()))
            if (!taken.getBoolean("ok")) {
                when (taken.getString("problem")) {
                    "challenge_malformed" -> fail(Stop("server", mapOf("code" to "challenge_malformed")))
                    "challenge_not_today" -> fail(Stop("date_mismatch"))
                    else -> fail(Stop.date(taken))
                }
            }
            code = DeviceCore.declarationCode(accounts, challenge.toByteArray())
        } catch (e: DeviceCoreException) {
            fail(Stop.core(e))
        }
        attempt.step("challenge")
        events.done(Item.CHALLENGE)
        checkIdle()

        val signature = try {
            sign(events, 3, code, pin ?: throw Stop("cancelled"))
        } catch (e: Stop) {
            // A PIN the card refuses is dropped, like everything else: the card proof starts again (issue #133).
            // So is the PIN of a card the secure channel cannot be made with: no tap of it will take the PIN (issue #365).
            if (e.code == "card" && (e.values["reason"] in ENDS_AT_LAST_TAP || e.values["reason"] == CardException.Reason.NO_NFC.name)) fail(e)
            throw e
        }
        // The last tap is made: the PIN is not needed again.
        dropPin()
        if (ended) signature.fill(0)
        live()
        attempt.step("code_signed")
        events.done(Item.SIGNED)

        val provedFrom = deps.elapsed()
        val record = try {
            val files = proofFiles()
            DeviceCore.sessionRecordsRequest(
                session, files.circuit, files.verificationKey, files.crsG1, files.crsG2,
                accounts, challenge.toByteArray(), scopeSignature ?: throw Stop("cancelled"), signature,
            )
        } catch (e: DeviceCoreException) {
            fail(
                when (e.code) {
                    DeviceCoreException.INPUT -> Stop("card_signature")
                    else -> Stop("engine")
                },
            )
        } finally {
            signature.fill(0)
        }
        // The proof holds everything the server needs: the certificate and the signatures are needed by no one.
        val status = status!!
        dropSecrets()
        live()
        attempt.took("proved", deps.elapsed() - provedFrom)
        attempt.step("proved")
        events.done(Item.PROVED)
        return submit(Unsent(record, shown, challenge, status.shortId))
    }

    /** The record [declare] made, sent again after the server turned it away as too many: nothing signed or computed again. */
    fun resubmit(): Done = counting {
        val kept = unsent
        if (kept == null || ended) throw Stop("state")
        attempt.resubmitted()
        submit(kept)
    }

    /**
     * The submission. Turned away as too many, the card proof does not end: the server did not record it, and [resubmit] sends
     * the same record again (docs/api/card-proof.md, "Rules for every endpoint"). Any other failure ends it.
     */
    private fun submit(record: Unsent): Done {
        unsent = null
        val answer = try {
            deps.backend.submit(deps.counts.deviceIdOrNull()?.let { withDeviceId(record.record, it) } ?: record.record)
        } catch (e: ServerException) {
            live()
            val stop = Stop.server(e, "submitting" to "true")
            if (!e.tooMany) fail(stop)
            keep { unsent = record }
            throw stop
        }
        ended = true
        attempt.step("done")
        val shown = record.shown
        return Done(shown.rows, Answer.of(answer, shown.rowsJson), shown.firstRecord, record.challenge.substring(0, 10), record.shortId, shown.accounts, validUntil)
    }

    // The end --------------------------------------------------------------------------

    /** Drops everything. The card proof cannot go on. */
    fun cancel() {
        ended = true
        tapCancel?.cancel()
        drop()
    }

    /** Gives up the tap that is waiting for a card (the panel's 取消): the step ends as one whose tap did not happen. */
    fun cancelTap() {
        tapCancel?.cancel()
    }

    @Synchronized
    private fun drop() {
        ended = true
        dropSecrets()
        status = null
        cardState = null
        chosen = null
        chosenAccountsJson = null
        validUntil = null
        cardStateTurnedAway = false
        unsent = null
    }

    private fun dropPin() {
        pin?.fill(0)
        pin = null
        firstSignedAt = null
    }

    private fun dropSecrets() {
        dropPin()
        scopeSignature?.fill(0)
        scopeSignature = null
        certificate?.fill(0)
        certificate = null
        // The core overwrites what it kept; if a step is inside the session, when that step returns.
        DeviceCore.sessionClose(session)
        session = 0
    }

    private fun answer(bytes: ByteArray): JSONObject = JSONObject(String(bytes, Charsets.UTF_8))

    /** The short ID (spec/scoped-id.md) of the scoped ID the core put in the request. */
    private fun shortIdOf(cardStateRequest: ByteArray): String =
        String(DeviceCore.shortId(answer(cardStateRequest).getString("scoped_id").toByteArray()), Charsets.US_ASCII)

    companion object {
        /** The longest the PIN waits between tap 2 and tap 3: 5 minutes (issue #133), as on the web page. */
        const val IDLE_MS = 5 * 60_000L

        /**
         * Why the last tap ended the card proof, the PIN dropped with everything else: the card refused the PIN, its PIN is locked,
         * or the secure channel could not be made (design/copy/card-proof.md, "5. 確認", app). Any other reason keeps the PIN, and
         * the tap is made again.
         */
        val ENDS_AT_LAST_TAP: Set<String> = setOf(CardException.Reason.PIN_INCORRECT.name, CardException.Reason.LOCKED.name, CardException.Reason.CHANNEL.name)

        /** Why the first tap is made again on the same card proof (Model's readButtonAfter); any other reason ends it. */
        private val TAPPED_AGAIN_AT_FIRST: Set<String> =
            setOf(CardException.Reason.NO_TAP.name, CardException.Reason.DROPPED.name, CardException.Reason.NFC_OFF.name, CardException.Reason.CANCELLED.name)

        /** Why the second tap ends the card proof (Model's confirmCard); any other reason has the PIN typed or the tap made again. */
        private val ENDS_AT_SECOND_TAP: Set<String> = setOf(CardException.Reason.LOCKED.name, CardException.Reason.NO_NFC.name)

        /**
         * The submission [record], the core's, carrying the card proof device ID (docs/api/card-proof.md, `device_id`): a
         * member the server writes in the connection log and nowhere else (ADR-0022, ADR-0039).
         */
        internal fun withDeviceId(record: ByteArray, deviceId: String): ByteArray {
            require(record.size > 2 && record[0] == '{'.code.toByte() && deviceId.length == 32 && deviceId.all { it in '0'..'9' || it in 'a'..'f' })
            return "{\"device_id\":\"$deviceId\",".toByteArray() + record.copyOfRange(1, record.size)
        }

        /**
         * `config`'s `paused` (docs/api/card-proof.md): whether the maintainer stopped taking card proofs. Absent is false; null when
         * it is there and is neither true nor false (spec/device-checks.md: `malformed_response`).
         */
        fun pausedIn(config: ByteArray): Boolean? = when (RawJson.member(config, "paused")?.toString(Charsets.UTF_8)) {
            null, "false" -> false
            "true" -> true
            else -> null
        }

        /**
         * What the minimum app version of `config` says of the build [appBuild] at the phone's clock [nowMs]
         * (spec/min-app.md), as the core reads it. Throws [Stop] `clock` for a clock the core does not take.
         */
        fun minApp(config: ByteArray, appBuild: Int, nowMs: Long): MinApp {
            val answer = try {
                JSONObject(String(DeviceCore.minApp(config, appBuild, nowMs / 1000), Charsets.UTF_8))
            } catch (e: DeviceCoreException) {
                // Whatever the config holds is a verdict, never an error: the one input the core refuses here is the clock.
                throw Stop(if (e.code == DeviceCoreException.INPUT) "clock" else "engine")
            }
            return when (answer.getString("verdict")) {
                "ok" -> MinApp.Ok
                "ok_until" -> MinApp.Until(answer.getString("from"))
                "stop" -> MinApp.TooOld(answer.getString("from"))
                else -> MinApp.Unreadable
            }
        }

        private const val CRS_G1 = "bn254_g1_compressed_2p18.dat"
        private const val CRS_G2 = "bn254_g2.dat"
    }
}

/**
 * Why a card proof stopped, or a step did not go through. It stays on the
 * phone: no request reports it (ADR-0016). [code] names the kind and
 * [values] what the sentence on the screen needs. Of what the card holds,
 * only the two dates of its certificate are ever in them, which the screen
 * shows (design/copy/card-proof.md, "憑證過期").
 *
 *   card            a tap: `reason` is a [CardException.Reason]
 *   other_card      taps 2 and 3: not the card of tap 1; the PIN was not sent
 *   certificate     `problem`, a reason code of spec/device-checks.md; `date`
 *   crl             `code`, a reason code; `days` for crl_stale
 *   revoked
 *   card_signature  a signature that is not the card's over its message
 *   artifact        a bundled file is not the one written into the core
 *   engine          the core failed
 *   server          `code`, the server's error code or what the app could not read;
 *                   `submitting` when it answered the submission; `too_many` when it
 *                   turned the request away as too many ([tooMany])
 *   date_mismatch   the challenge is not dated today by the phone's clock
 *   idle            [CardProof.IDLE_MS] passed after tap 2
 *   min_app         this build is older than the server's minimum app version, since `from`
 *   clock           the phone's clock is outside the years the core takes
 *   cancelled, state
 */
class Stop(val code: String, val values: Map<String, String> = emptyMap(), val requestId: String? = null) : Exception(code) {
    /** The server turned the request away as too many ([ServerException.tooMany]): the same request can be sent again. */
    val tooMany: Boolean get() = code == "server" && values["too_many"] == "true"

    companion object {
        fun server(e: ServerException, vararg more: Pair<String, String>) =
            Stop("server", mapOf("code" to e.code) + (if (e.tooMany) mapOf("too_many" to "true") else emptyMap()) + more, e.requestId)

        fun core(e: DeviceCoreException) = Stop(if (e.code == DeviceCoreException.ARGUMENT) "clock" else "engine")

        /** A certificate that did not pass (`{"ok":false,"problem":…}` of the core). */
        fun certificate(answer: JSONObject): Stop {
            val problem = answer.getString("problem")
            val time = answer.optString(if (problem == "expired") "not_after" else "not_before")
            return Stop("certificate", mapOf("problem" to problem) + (certificateDay(time)?.let { mapOf("date" to it) } ?: emptyMap()))
        }

        /** A CRL that did not pass. */
        fun crl(answer: JSONObject): Stop {
            val problem = answer.getString("problem")
            return Stop("crl", mapOf("code" to problem) + if (problem == "crl_stale") mapOf("days" to answer.getInt("days").toString()) else emptyMap())
        }

        /** The date conditions, checked again, did not hold. */
        fun date(answer: JSONObject): Stop = if (answer.getString("problem") == "crl_stale") crl(answer) else certificate(answer)

        /** A certificate's time, `YYMMDDHHMMSS` in UTC, as its date in Taiwan. */
        internal fun certificateDay(t: String): String? {
            if (t.length != 12 || !t.all { it in '0'..'9' }) return null
            val n = { from: Int -> t.substring(from, from + 2).toInt() }
            return try {
                java.time.LocalDateTime.of(2000 + n(0), n(2), n(4), n(6), n(8), n(10)).plusHours(8).toLocalDate().toString()
            } catch (e: java.time.DateTimeException) {
                null
            }
        }
    }
}

/** What the minimum app version says of this build (spec/min-app.md, "What the app does"). */
sealed interface MinApp {
    /** The app goes on as usual. */
    data object Ok : MinApp

    /** The app goes on as usual, and says that from [from] (`YYYY-MM-DD`, in Taiwan) this version can no longer do a card proof. */
    data class Until(val from: String) : MinApp

    /** This version can no longer do a card proof, since [from]: no PIN is asked for and no card read. */
    data class TooOld(val from: String) : MinApp

    /** The field cannot be read: the app does not go on, as with a platform table it cannot read. */
    data object Unreadable : MinApp
}

/** A list that cannot be signed (spec/list-consequence.md): `username`, `empty`, `switch_limit`, `daily_limit`. The cardholder changes the list. */
class Blocked(val reason: String, val platform: String?) : Exception(reason)
