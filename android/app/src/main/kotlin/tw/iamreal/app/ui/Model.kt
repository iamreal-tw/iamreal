package tw.iamreal.app.ui

import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import tw.iamreal.app.Wiring
import tw.iamreal.app.backend.Backend
import tw.iamreal.app.backend.ServerException
import tw.iamreal.app.card.CardException
import tw.iamreal.app.card.SecureChannel
import tw.iamreal.app.flow.Blocked
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.flow.Counts
import tw.iamreal.app.flow.MinApp
import tw.iamreal.app.flow.Platforms
import tw.iamreal.app.flow.Stop
import tw.iamreal.app.ui.demo.HangDemoPlayer
import tw.iamreal.app.ui.demo.HangTimeline
import tw.iamreal.app.ui.demo.SenseDemoPlayer
import java.security.SecureRandom
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import kotlin.concurrent.thread

/**
 * The eight steps (design/copy/card-proof.md); the declaration under way is still step 5. After the submission, one thing a
 * step: hang the link (6), the reminder (7), done and share (8). A card proof that withdrew everything goes from 5 to 8.
 */
internal enum class Step(val number: Int) {
    BEFORE(1), READ(2), PIN(3), ACCOUNTS(4), CONFIRM(5), PROGRESS(5), HANG(6), REMIND(7), DONE(8);

    /** After the submission: the card proof is recorded, and nothing of the card is kept. */
    val submitted: Boolean get() = number >= 6

    companion object {
        /** "第 2 步，共 8 步": the same from step 1 on. */
        const val COUNT = 8
    }
}

/** What an item of a list shows after it: nothing yet, in progress, done, stopped here. */
internal enum class ItemState { NONE, NOW, DONE, HALT }

/** The buttons of step 2. */
internal enum class ReadButton { TAP, TAP_AGAIN, NFC, RESTART, NEXT }

/**
 * Which screen of step 4 (design/copy/card-proof.md, "4. 你的帳號"): as it opens (rows to fill, or what the card
 * declares and the actions); after accounts.switch (one platform); after accounts.edit_list (several).
 */
internal enum class AccountsMode { OPEN, SWITCH, EDIT }

/** What stands in the place of step 1: a phone that cannot read a card, or a version of the app that can no longer do a card proof. */
internal enum class Gate { NO_NFC, TOO_OLD }

/** The buttons under step 5's list when it stopped. RETRY: the server turned a request away as too many, and it is sent again. */
internal enum class ProgressButton { NONE, TAP_AGAIN, RETRY, RESTART }

/**
 * Step 2's button after a stop: a tap that did not happen is made again on the same card proof; anything else, the server's
 * `paused` among them, starts a new one.
 */
internal fun readButtonAfter(stop: Stop): ReadButton {
    val reason = stop.values["reason"]
    return when {
        stop.code != "card" -> ReadButton.RESTART
        reason == CardException.Reason.NO_TAP.name || reason == CardException.Reason.DROPPED.name -> ReadButton.TAP_AGAIN
        reason == CardException.Reason.NFC_OFF.name -> ReadButton.NFC
        else -> ReadButton.RESTART
    }
}

/**
 * Step 5's button after a stop. Too many people: 再試一次. The tap did not get to a signature: the PIN is still there, and the
 * tap is made again. A PIN the card refused, a card that is locked, a card the secure channel cannot be made with: the flow
 * dropped the PIN with everything else, and the only way on is back to the beginning; so for any other stop of the server,
 * `paused` among them.
 */
internal fun progressButtonAfter(stop: Stop): ProgressButton {
    // Too many people: the challenge, or the record, is asked for or sent again (design/copy/card-proof.md, "5. 確認", 進行中).
    if (stop.tooMany) return ProgressButton.RETRY
    val again = stop.code == "other_card" || (stop.code == "card" && stop.values["reason"] !in CardProof.ENDS_AT_LAST_TAP)
    return if (again) ProgressButton.TAP_AGAIN else ProgressButton.RESTART
}

/**
 * The PIN as it is typed: characters in an array this class overwrites,
 * never a String of the app's. It is in memory only: not in the saved
 * state of the activity, not in any file.
 */
internal class PinField(private val onFirst: () -> Unit = {}) {
    private val chars = CharArray(MAX)
    var length by mutableIntStateOf(0)
        private set

    /** When the first character of the PIN that is here came, on the phone's clock in milliseconds; null while the field is empty. */
    var since: Long? = null
        private set

    fun append(c: Char) {
        // What a card's PIN can be made of: printable ASCII.
        if (length < MAX && c in '!'..'~') {
            chars[length++] = c
            if (length == 1) {
                since = System.currentTimeMillis()
                onFirst()
            }
        }
    }

    fun removeLast() {
        if (length > 0) chars[--length] = 0.toChar()
        if (length == 0) since = null
    }

    fun clear() {
        chars.fill(0.toChar())
        length = 0
        since = null
    }

    /** The PIN as the card takes it; the caller overwrites the bytes. */
    fun bytes(): ByteArray = ByteArray(length) { chars[it].code.toByte() }

    private companion object {
        const val MAX = 32
    }
}

/**
 * What the screens show, and what a button does: the card proof
 * ([CardProof]) run step by step on a background thread, its state held
 * here for the screens to draw. One of it lives as long as the app's
 * process; nothing of it is saved anywhere, so an app the system ended
 * starts at step 1.
 */
internal class Model(
    private val wiring: Wiring,
    private val bundled: (String) -> ByteArray,
    private val crlNumbers: CardProof.CrlNumbers,
    val copy: Copy,
    /** design/motion/hang.json, as the installer carries it: read when a card proof first gets to step 6. */
    hangMotion: () -> String,
    /** design/motion/sense.json, as the installer carries it: read when step 2 first comes up. */
    senseMotion: () -> String,
    /** Where the card proof device ID is kept (flow/Counts.kt). */
    deviceIdStore: Counts.Store,
    /** The app's own version as the store shows it (`versionName`). */
    appVersion: String,
) {
    val messages = Messages(copy)
    private val backend = Backend(wiring.site, wiring.data)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "card-proof") }

    /** The counts' requests, one after the other, never in the way of a card proof's. */
    private val sender = Executors.newSingleThreadExecutor { Thread(it, "counts") }

    private val counts = Counts(object : Counts.Deps {
        override fun send(body: ByteArray) {
            sender.execute { backend.count(body) }
        }

        override fun now() = System.currentTimeMillis()

        override fun random(bytes: ByteArray) = source.nextBytes(bytes)

        private val source = SecureRandom()
        override val store = deviceIdStore
        override val client = "android"
        override val osVersion: String = Build.VERSION.RELEASE ?: ""
        override val appVersion = appVersion
        override val model: String = Build.MODEL ?: ""
    })

    /** The counts of the card proof to come or under way (flow/Counts.kt); its first count is `open`, as step 1 shows. */
    private var attempt: Counts.Attempt? = null

    /**
     * Step 1 shows: the first screen of a card proof (spec/counts.md, `open`). A new attempt, unless the one there has not
     * begun: the cardholder came back to step 1 without a card read.
     */
    private fun opened() {
        if (attempt?.begun != false) attempt = counts.attempt().also { it.step("open") }
    }

    init {
        opened()
    }
    private var flow: CardProof? = null

    var step by mutableStateOf(Step.BEFORE)
        private set

    /**
     * The operator stopped taking card proofs, as the server's config last said (docs/api/card-proof.md, `paused`): step 1
     * says so in place of its button. Until the config answers, and when it does not: false, and step 2 asks again. Written on
     * the main thread only; the Model is made there, so the first answer finds [config] set.
     */
    var paused by mutableStateOf(false)
        private set

    /**
     * What the minimum app version of the server's config last said of this build (spec/min-app.md; ADR-0035): step 1
     * says from which date this version can no longer do a card proof, or is replaced when it no longer can. Until the
     * config answers, and when it does not or cannot be read: [MinApp.Ok], and step 2 asks again and stops there.
     */
    var minApp by mutableStateOf<MinApp>(MinApp.Ok)
        private set

    /** Whether this phone can read a card at all; a phone without NFC has step 1 replaced. True until the card says otherwise. */
    var hasNfc by mutableStateOf(true)
        private set

    init {
        thread(name = "nfc") {
            val has = wiring.card.hasNfc
            main.post { hasNfc = has }
        }
    }

    /** What stands in the place of step 1 (design/copy/card-proof.md, "1. 開始之前", app), if anything: nothing of a card proof can be reached from it. */
    val gate: Gate?
        get() = when {
            !hasNfc -> Gate.NO_NFC
            minApp is MinApp.TooOld -> Gate.TOO_OLD
            else -> null
        }

    /** Above step 1: why the card proof came back to it. */
    var notice by mutableStateOf<String?>(null)
        private set

    /** Step 1's 下一步 was pressed, and the server has not answered yet ([start]). */
    var starting by mutableStateOf(false)
        private set

    /**
     * The server turned the start away as too many (`config?start`, docs/api/card-proof.md): step 1 says so above its 下一步,
     * which stays, to be pressed again (design/copy/card-proof.md, "1. 開始之前", 人太多的時候).
     */
    var startTurnedAway by mutableStateOf(false)
        private set

    /**
     * What `config` answered when step 1's 下一步 was last pressed: the card proofs that follow without step 1 (再感應一次卡片, step 3's
     * 上一步) fall back on it when the server turns their `config` away as too many.
     */
    private var startConfig: ByteArray? = null

    /** The panel of a tap, or null. */
    var panel by mutableStateOf<CardProof.Tap?>(null)
        private set

    // Step 2
    private val senseJson by lazy(senseMotion)

    /** The demonstration of where the card goes, for this visit of step 2: it plays by itself once, and rests when the card is asked for. */
    var senseDemo by mutableStateOf<SenseDemoPlayer?>(null)
        private set

    var readItems by mutableStateOf(List(4) { ItemState.NONE })
        private set
    var readMessage by mutableStateOf<String?>(null)
        private set
    var readButton by mutableStateOf(ReadButton.TAP)
        private set
    var readBusy by mutableStateOf(false)
        private set

    // Step 3
    /** The name on the card: shown before the PIN, sent nowhere. */
    var name by mutableStateOf("")
        private set
    val pin = PinField(onFirst = { main.postDelayed({ checkIdle() }, CardProof.IDLE_MS) })

    /** When the PIN the flow keeps for the last tap was first typed: its 5 minutes go on from the field to the flow. */
    private var keptPinSince: Long? = null

    /**
     * The PIN, in the field or kept for the last tap, has been on the phone [CardProof.IDLE_MS] since its first character came
     * (issue #133: 5 minutes at most). A clock that was set back does not make it longer.
     */
    private fun pinExpired(): Boolean {
        val since = keptPinSince ?: pin.since ?: return false
        val now = System.currentTimeMillis()
        return now - since >= CardProof.IDLE_MS || now < since
    }
    var pinBusy by mutableStateOf<String?>(null)
        private set
    var pinMessage by mutableStateOf<String?>(null)
        private set

    /** What step 3 says under the PIN's field. "請輸入 PIN。" and the sentence of the PIN's form only while the field is empty (design/copy/card-proof.md, "3. 輸入 PIN", app). */
    val pinNote: String? get() = pinMessage?.takeUnless { (it == copy.say("app_pin.need_pin") || it == copy.say("app_pin.pin_format")) && pin.length > 0 }

    /**
     * The tap of step 3 did not get as far as a PIN the card refused, and the PIN typed is still the one to send:
     * the card left, or was not the card that was read. The one button is 再感應一次, and the field is not typed in
     * (design/copy/card-proof.md, "3. 輸入 PIN", app: "PIN 還在，不用再輸入").
     */
    var pinKept by mutableStateOf(false)
        private set

    /** The card proof ended while the PIN was asked for: the only way on is to read the card again. */
    var pinEnded by mutableStateOf(false)
        private set

    /**
     * The card signed and the server turned its state away as too many: 再試一次 asks again, nothing signed again; the PIN is the
     * flow's, kept for the last tap, and the field is not typed in (design/copy/card-proof.md, "3. 輸入 PIN").
     */
    var pinRetry by mutableStateOf(false)
        private set

    // Step 4
    var status by mutableStateOf<CardProof.Status?>(null)
        private set
    var accountsMode by mutableStateOf(AccountsMode.OPEN)
        private set
    val fields = mutableStateMapOf<String, String>()
    val rowMessages = mutableStateMapOf<String, String>()
    var listMessage by mutableStateOf<String?>(null)
        private set

    // Step 5
    var consequence by mutableStateOf<CardProof.Consequence?>(null)
        private set
    var progressItems by mutableStateOf(List(4) { ItemState.NONE })
        private set
    var progressMessage by mutableStateOf<String?>(null)
        private set
    var progressRequestId by mutableStateOf<String?>(null)
        private set
    var progressButton by mutableStateOf(ProgressButton.NONE)
        private set

    /** The card has signed: it can be taken away. */
    var signed by mutableStateOf(false)
        private set

    /** The server turned the submission away as too many: step 5's 再試一次 sends the same record again. */
    private var submitTurnedAway = false

    // Steps 6 to 8
    var done by mutableStateOf<CardProof.Done?>(null)
        private set

    private val hangTimeline by lazy { HangTimeline(hangMotion()) }

    /** The demonstration of step 6, for this card proof: where it has got to is kept while the steps after the submission are gone through, so coming back to step 6 does not play it again from its start. */
    var hangDemo by mutableStateOf<HangDemoPlayer?>(null)
        private set

    /** Step 6 is the whole one: "重新掛上連結" was pressed on the short one. */
    var hangWhole by mutableStateOf(false)
        private set
    var single by mutableStateOf<String?>(null)
        private set

    val domain: String get() = wiring.domain

    /**
     * Step 3's sentences that speak of the card's accounts: as on step 1, by the platforms the app knows; with one, they name it
     * (card-proof.md, step 3).
     */
    fun pinSays(key: String): String =
        Platforms.known.singleOrNull()?.let { copy.say(key + "_single", "platform" to it.name) } ?: copy.say(key)

    /** The site the app talks to, without a slash at the end: the settings' links open its pages. */
    val site: String get() = wiring.site

    /** Told of every card proof that is completed: the reminder comes again from today. */
    var onDone: (CardProof.Done) -> Unit = {}

    /** The address of a card's page on the site. */
    fun proofUrl(shortId: String): String = "${wiring.site}/p/$shortId"

    // The server's config: asked for when the app opens --------------------------------

    private var config: FutureTask<ByteArray> = askConfig()

    private fun askConfig(): FutureTask<ByteArray> = FutureTask { backend.config() }.also {
        thread(name = "config") {
            it.run()
            val said = try { CardProof.pausedIn(it.get()) == true } catch (e: ExecutionException) { false }
            // An answer that did not come, or a clock the core does not take, says nothing of the version: what the last answer
            // said stands, and step 2 stops there. A field that cannot be read leaves step 1 as usual: step 2 says so.
            val version = try { CardProof.minApp(it.get(), wiring.appBuild, System.currentTimeMillis()) } catch (e: ExecutionException) { null } catch (e: Stop) { null }
            // Not when it was asked again meanwhile: the later answer says.
            main.post {
                if (synchronized(this@Model) { config === it }) {
                    paused = said
                    if (version != null) minApp = if (version == MinApp.Unreadable) MinApp.Ok else version
                }
            }
        }
    }

    /**
     * The config, once the server answered. An answer that did not come is asked for again the next time; one that said card
     * proofs are stopped is asked for again now, once: the operator may have resumed since.
     */
    private fun awaitConfig(): ByteArray {
        val kept = answerOf(synchronized(this) { config })
        if (CardProof.pausedIn(kept) != true) return kept
        return answerOf(synchronized(this) { askConfig().also { config = it } })
    }

    private fun answerOf(asked: FutureTask<ByteArray>): ByteArray {
        try {
            return asked.get()
        } catch (e: ExecutionException) {
            synchronized(this) { if (config === asked) config = askConfig() }
            throw e.cause as? ServerException ?: ServerException(Backend.NETWORK, 0, null)
        }
    }

    /** A new card proof; [started], the start's config it falls back on ([startConfig]). */
    private fun newFlow(started: ByteArray?): CardProof {
        flow?.cancel()
        return CardProof(object : CardProof.Deps {
            override val backend = this@Model.backend
            override val card = wiring.card
            override fun config() = awaitConfig()
            override fun openSession() = wiring.openSession()
            override fun bundled(name: String) = this@Model.bundled(name)
            override fun now() = System.currentTimeMillis()
            override val appBuild = wiring.appBuild
            override val crlNumbers = this@Model.crlNumbers
            override val counts = this@Model.counts

            // The one step 1 opened, unless a card was read for it: a card proof started again from step 2 is another.
            override val attempt = this@Model.attempt?.takeIf { !it.begun } ?: this@Model.counts.attempt().also { this@Model.attempt = it }
        }, started).also { flow = it }
    }

    /** Runs a step of [f] off the main thread; [then] and [failed] run on the main thread, unless the card proof is no longer [f]. */
    private fun <T> step(f: CardProof, step: () -> T, then: (T) -> Unit, failed: (Stop) -> Unit) {
        worker.execute {
            val result = try {
                Result.success(step())
            } catch (e: Stop) {
                Result.failure(e)
            } catch (e: Exception) {
                // Whatever else went wrong carries nothing to show: the card proof stopped, and keeps nothing.
                f.end(Stop("engine"))
                Result.failure(Stop("engine"))
            }
            main.post {
                if (flow !== f) return@post
                result.fold(then) { failed(it as Stop) }
            }
        }
    }

    /** Panel and list updates from the step's thread, in order, on the main thread. */
    private fun events(f: CardProof, onDone: (CardProof.Item) -> Unit) = object : CardProof.Events {
        override fun done(item: CardProof.Item) {
            main.post { if (flow === f) onDone(item) }
        }

        override fun tap(panel: CardProof.Tap?) {
            main.post {
                if (flow !== f) return@post
                val shown = this@Model.panel
                // "可以拿開卡片了" stays for a moment before the panel closes.
                if (panel == null && (shown == CardProof.Tap.READ || shown == CardProof.Tap.SIGNED)) {
                    main.postDelayed({ if (this@Model.panel == shown) this@Model.panel = null }, PANEL_DONE_MS)
                } else {
                    this@Model.panel = panel
                }
                // Step 3: once the card has signed, the line beside the button says what comes next.
                if (panel == CardProof.Tap.SIGNED && pinBusy != null) pinBusy = pinSays("app_pin.signed")
            }
        }
    }

    /** The states of a list whose first [doneCount] items are done; the next is in progress while [running], or stopped. */
    private fun items(size: Int, doneCount: Int, running: Boolean, halted: Boolean = false): List<ItemState> = List(size) {
        when {
            it < doneCount -> ItemState.DONE
            it == doneCount && halted -> ItemState.HALT
            it == doneCount && running -> ItemState.NOW
            else -> ItemState.NONE
        }
    }

    // Step 1 ---------------------------------------------------------------------------

    /**
     * 下一步: the start of a card proof, `config` asked with its mark ([CardProof.begin]) before step 2. Turned away as too many,
     * step 1 stays and says so; card proofs stopped, step 1 says that in place of 下一步. No answer: on to step 2, which asks again.
     */
    fun start() {
        // Nothing of a card proof from a screen that stands in the place of step 1.
        if (gate != null || starting) return
        dropAll()
        notice = null
        startTurnedAway = false
        starting = true
        val f = newFlow(null)
        step(
            f,
            { f.begin() },
            {
                starting = false
                startConfig = f.startedWith
                // The reading asks config again, without the mark (CardProof.readCard): asked now, while step 2 comes up.
                askConfigAgain()
                toRead(f)
            },
            { stop ->
                starting = false
                when {
                    stop.tooMany -> startTurnedAway = true
                    stop.code == "server" && stop.values["code"] == "paused" -> paused = true
                }
            },
        )
    }

    // Step 2 ---------------------------------------------------------------------------

    /** Step 2 with nothing read: [begun], the card proof step 1 began; otherwise a new one, which falls back on the start's config. */
    private fun toRead(begun: CardProof? = null) {
        if (begun == null) {
            dropAll()
            newFlow(startConfig)
        }
        senseDemo = SenseDemoPlayer(senseJson)
        readItems = items(4, 0, false)
        readMessage = null
        readButton = ReadButton.TAP
        readBusy = false
        step = Step.READ
    }

    /** Step 1 in front again: asks the server whether card proofs are stopped, or resumed, meanwhile, and what its minimum app version is now. */
    fun checkConfig() {
        if (step == Step.BEFORE) askConfigAgain()
    }

    /**
     * Step 1 asks the server for its config each time it opens, as the web page does (design/copy/card-proof.md, step 1: the
     * operator stopping card proofs is said before a card is read); the card proof that follows uses that answer. Not while an
     * answer is still to come.
     */
    private fun askConfigAgain() {
        synchronized(this) { if (config.isDone) config = askConfig() }
    }

    fun backToBefore() {
        dropAll()
        askConfigAgain()
        step = Step.BEFORE
        opened()
    }

    /** "感應卡片", and "再感應一次": the tap of step 2, on the card proof that is there. */
    fun tapToRead() {
        val f = flow ?: return
        var doneCount = 0
        // The demonstration rests with the card in place, and does not move by itself again: the panel of the tap is over a still screen.
        senseDemo?.stop()
        readBusy = true
        readMessage = null
        readItems = items(4, 0, true)
        step(
            f,
            {
                f.readCard(events(f) {
                    doneCount++
                    readItems = items(4, doneCount, true)
                })
            },
            { read ->
                name = read.name
                readItems = items(4, 4, false)
                readBusy = false
                readButton = ReadButton.NEXT
            },
            { stop ->
                readBusy = false
                if (replacesStepOne(stop)) return@step
                val reason = stop.values["reason"]
                if (stop.code == "card" && reason == CardException.Reason.CANCELLED.name) {
                    // Back to the screen as it was before the button was pressed.
                    readItems = items(4, 0, false)
                    readButton = ReadButton.TAP
                    return@step
                }
                readItems = items(4, doneCount, false, halted = true)
                readMessage = messages.stop(stop, Messages.At.READ)
                readButton = readButtonAfter(stop)
            },
        )
    }

    /** "再感應一次卡片": a new card proof, and its tap at once. */
    fun readAgain() {
        // A new card proof asks the server again: the answer the last one stopped at may have been the reason.
        askConfigAgain()
        toRead()
        tapToRead()
    }

    fun toPin() {
        pin.clear()
        keptPinSince = null
        pinBusy = null
        pinMessage = null
        pinEnded = false
        pinKept = false
        pinRetry = false
        step = Step.PIN
    }

    // Step 3 ---------------------------------------------------------------------------

    /** "上一步" of step 3: the card is read again, a new card proof. */
    fun backToRead() = toRead()

    fun confirmCard() {
        val f = flow ?: return
        if (pinExpired()) return stopped(Stop("idle"))
        if (pin.length == 0) {
            // Never sent without a PIN: no panel.
            pinMessage = copy.say("app_pin.need_pin")
            return
        }
        val typed = pin.bytes()
        // A PIN no card takes is not sent, and no panel comes up: it is typed again.
        val block = SecureChannel.pinBlock(typed)
        if (block == null) {
            typed.fill(0)
            pin.clear()
            pinMessage = copy.say("app_pin.pin_format")
            return
        }
        block.fill(0)
        pinMessage = null
        pinBusy = ""
        step(
            f,
            {
                try {
                    f.confirmCard(typed, events(f) {})
                } finally {
                    typed.fill(0)
                }
            },
            ::cardStateKnown,
            ::pinStopped,
        )
    }

    /** 再試一次 of step 3: the card's state asked again, after the server turned it away as too many. Nothing is signed again. */
    fun retryCardState() {
        val f = flow ?: return
        if (pinExpired()) return stopped(Stop("idle"))
        pinMessage = null
        // The card has signed: the line beside the button says what is being done.
        pinBusy = pinSays("app_pin.signed")
        step(f, { f.retryCardState() }, ::cardStateKnown, ::pinStopped)
    }

    /** Step 3 is done: the PIN is the flow's now, kept for the last tap. */
    private fun cardStateKnown(status: CardProof.Status) {
        keptPinSince = pin.since ?: keptPinSince
        pin.clear()
        pinBusy = null
        pinRetry = false
        showAccounts(status)
        main.postDelayed({ checkIdle() }, CardProof.IDLE_MS)
    }

    /** Step 3 stopped: what it says under the PIN's field, and the way on. */
    private fun pinStopped(stop: Stop) {
        pinBusy = null
        if (replacesStepOne(stop)) return
        pinMessage = messages.stop(stop, Messages.At.PIN)
        pinRetry = false
        val reason = stop.values["reason"]
        when {
            // The card signed, and the server turned its state away as too many: the flow keeps the PIN for the last tap,
            // and 再試一次 asks again.
            stop.tooMany -> {
                keptPinSince = pin.since ?: keptPinSince
                pin.clear()
                pinKept = false
                pinRetry = true
            }
            // The card did not take the PIN, or may have: it is typed again (never sent again by itself).
            // Nor is it kept for a card the secure channel cannot be made with: the sentence sends the cardholder to a card reader,
            // and another tap needs the PIN typed again (design/copy/card-proof.md, "3. 輸入 PIN", app).
            // Nor for an answer of the card the app does not know: it may be its answer to the PIN.
            stop.code == "card" && reason in setOf(CardException.Reason.PIN_INCORRECT.name, CardException.Reason.PIN_MAYBE_SENT.name, CardException.Reason.CHANNEL.name, CardException.Reason.OTHER.name) -> {
                pin.clear()
                pinKept = false
            }
            // A locked card takes no PIN: the card proof is over.
            stop.code == "card" && reason == CardException.Reason.LOCKED.name -> {
                pin.clear()
                pinKept = false
                pinEnded = true
            }
            // The PIN did not reach a card, or the tap was cancelled: the same PIN, the tap again.
            stop.code == "card" || stop.code == "other_card" -> {
                // Cancelling the panel is back to the screen as it was; anything else offers the tap again.
                // A PIN that was kept stays kept, and its field shut, through a cancelled panel: the card may have taken it already.
                val cancelled = reason == CardException.Reason.CANCELLED.name
                pinKept = pinKept || !cancelled
                if (pinMessage == null && !cancelled) pinMessage = copy.say("common.halted")
            }
            else -> {
                pin.clear()
                pinKept = false
                pinEnded = true
                if (pinMessage == null) pinMessage = copy.say("common.halted")
            }
        }
    }

    // Step 4 ---------------------------------------------------------------------------

    private fun showAccounts(status: CardProof.Status) {
        // The card has had its 3 card proofs today: it will not sign again in this one, so the PIN the flow keeps for
        // the last tap goes now, not when 回到開頭 is pressed (design/copy/card-proof.md, "今天已經過卡 3 次").
        if (status.dailyLimit) {
            flow?.cancel()
            flow = null
            keptPinSince = null
        }
        this.status = status
        single = messages.onePlatform(status)
        openAccounts(AccountsMode.OPEN)
        step = Step.ACCOUNTS
    }

    /** A screen of step 4 as it first shows: each field holds the account its row has now; the one of accounts.switch is empty. */
    private fun openAccounts(mode: AccountsMode) {
        val status = status ?: return
        accountsMode = mode
        fields.clear()
        for (slot in status.slots) if (slot.known) fields[slot.platform] = slot.current ?: ""
        if (mode == AccountsMode.SWITCH) messages.switchSlot(status)?.let { fields[it.platform] = "" }
        rowMessages.clear()
        listMessage = null
    }

    /** "改成別的帳號": the same step, with a field for the other account. */
    fun switchAccount() {
        // Only with an account to change: the screen is drawn from that row.
        if (status?.let(messages::switchSlot) != null) openAccounts(AccountsMode.SWITCH)
    }

    /** "修改帳號清單": the same step, with a row for each platform. */
    fun editList() = openAccounts(AccountsMode.EDIT)

    /** 上一步 of the screens opened from step 4: back to what the card declares, nothing typed kept. */
    fun keep() = openAccounts(AccountsMode.OPEN)

    /** The card's list as it is: each platform the screens offer, its account now or "". */
    private fun listNow(status: CardProof.Status): Map<String, String> = status.slots.filter { it.known }.associate { it.platform to (it.current ?: "") }

    /** "更新島民證明": the list as it is, to step 5. */
    fun refresh() {
        choose(listNow(status ?: return))
    }

    /** "收回對 @alice 的宣告" (one platform): the list without it, to step 5. */
    fun withdraw() {
        choose(listNow(status ?: return).mapValues { "" })
    }

    /** What is typed into a row's field. What was said of the row and of the list when a button was last pressed is no longer about what is there. */
    fun type(platform: String, text: String) {
        fields[platform] = text
        rowMessages.remove(platform)
        listMessage = null
    }

    /** What is in a row's field, tidied the way its platform writes an account. */
    fun typed(platform: String): String = Platforms.of(platform)?.normalize(fields[platform] ?: "") ?: ""

    /** The account of a row, if what is typed is in the platform's format; says so under the row if not. For "預覽". */
    fun previewUrl(platform: String): String? {
        val f = flow ?: return null
        val username = typed(platform)
        if (username.isEmpty()) return null
        rowMessages.remove(platform)
        return try {
            if (f.inFormat(platform, username)) {
                Platforms.of(platform)?.profileUrl?.invoke(username)
            } else {
                rowMessages[platform] = messages.formatHint(platform)
                null
            }
        } catch (e: Stop) {
            stopped(e)
            null
        }
    }

    /** "下一步" of a screen with fields: the list as typed, to step 5. */
    fun toConfirm() {
        val status = status ?: return
        if (accountsMode != AccountsMode.SWITCH) return choose(fields.keys.associateWith { typed(it) })
        val platform = messages.switchSlot(status)?.platform ?: return
        val username = typed(platform)
        if (username.isEmpty()) {
            // Withdrawing is the other action: an empty field goes nowhere.
            rowMessages[platform] = copy.say("accounts.need_one")
            return
        }
        choose(listNow(status) + (platform to username))
    }

    /** Step 5 for the list [entries], or under a row or the list why it cannot be signed. Whatever was pressed on step 4, what goes on is one list. */
    private fun choose(entries: Map<String, String>) {
        val f = flow ?: return
        rowMessages.clear()
        listMessage = null
        try {
            consequence = f.choose(entries)
            step = Step.CONFIRM
        } catch (e: Blocked) {
            when (e.reason) {
                "username" -> rowMessages[e.platform!!] = messages.formatHint(e.platform)
                "switch_limit" -> rowMessages[e.platform!!] = copy.say("accounts.row_cannot_switch")
                "daily_limit" -> listMessage = copy.say("stops.daily_limit")
                else -> listMessage = copy.say("accounts.need_one")
            }
        } catch (e: Stop) {
            stopped(e)
        }
    }

    // Step 5 ---------------------------------------------------------------------------

    /** "上一步" of step 5: the screen of step 4 the button was pressed on, its fields as they were typed. */
    fun backToAccounts() {
        consequence = null
        step = Step.ACCOUNTS
    }

    /** The button of step 5, and "再感應一次" under its list: the challenge, the last tap, the proof, the submission. */
    fun declare() {
        val f = flow ?: return
        if (pinExpired()) return stopped(Stop("idle"))
        progress(f, 0) { f.declare(it) }
    }

    /**
     * 再試一次 under step 5's list, after the server turned a request away as too many: the challenge asked for again, then the
     * last tap as usual; or, once the card signed and the proof was made, the same record sent again.
     */
    fun retryDeclare() {
        val f = flow ?: return
        if (!submitTurnedAway) return declare()
        progress(f, 3) { f.resubmit() }
    }

    /** Step 5 in progress: [run] on the card proof, the first [from] items of the list done already. */
    private fun progress(f: CardProof, from: Int, run: (CardProof.Events) -> CardProof.Done) {
        var doneCount = from
        submitTurnedAway = false
        progressItems = items(4, from, true)
        progressMessage = null
        progressRequestId = null
        progressButton = ProgressButton.NONE
        if (from == 0) signed = false
        step = Step.PROGRESS
        step(
            f,
            {
                run(events(f) {
                    doneCount++
                    if (it == CardProof.Item.SIGNED) signed = true
                    progressItems = items(4, doneCount, true)
                })
            },
            { done ->
                progressItems = items(4, 4, false)
                this.done = done
                dropAll(keepDone = true)
                onDone(done)
                hangWhole = false
                hangDemo = HangDemoPlayer(hangTimeline)
                // Everything withdrawn: nothing to hang, to be reminded of or to share.
                step = if (done.accounts.isEmpty()) Step.DONE else Step.HANG
            },
            { stop ->
                if (stop.code == "idle") return@step stopped(stop)
                if (replacesStepOne(stop)) return@step
                if (stop.tooMany && stop.values["submitting"] == "true") {
                    // The card signed for the last time and the PIN is gone: nothing of it waits now, only the record.
                    submitTurnedAway = true
                    keptPinSince = null
                }
                progressItems = items(4, doneCount, false, halted = true)
                progressMessage = messages.stop(stop, Messages.At.DECLARE)
                progressRequestId = stop.requestId
                progressButton = progressButtonAfter(stop)
            },
        )
    }

    // Steps 6 to 8 -----------------------------------------------------------------------

    /** "重新掛上連結": step 6 still, the whole of it. */
    fun hangAgain() {
        hangWhole = true
    }

    /** Step 4's 今天已經過卡 3 次 showed the whole of step 6 (重新掛上連結); 上一步 goes back to it. */
    var hangFromLimit by mutableStateOf(false)
        private set

    /** 重新掛上連結 of step 4's 今天已經過卡 3 次: the whole of step 6 for the accounts the card declares now. */
    fun showHangFromLimit() {
        if (status == null) return
        hangDemo = HangDemoPlayer(hangTimeline)
        hangFromLimit = true
    }

    /** 上一步 of the whole step 6 shown from step 4: step 4's 今天已經過卡 3 次 again. */
    fun backFromHangFromLimit() {
        hangFromLimit = false
        hangDemo = null
    }

    /** "上一步" of the whole step 6, reached from the short one: the short one again. */
    fun hangShort() {
        hangWhole = false
    }

    /** "下一步" of step 6. */
    fun toRemind() {
        if (done != null) step = Step.REMIND
    }

    /** "上一步" of step 7: step 6 as it was left. */
    fun backToHang() {
        if (done != null) step = Step.HANG
    }

    /** "上一步" of step 8: step 7; false where there is none (everything was withdrawn: step 8 came straight from step 5). */
    fun backFromDone(): Boolean {
        if (done?.accounts?.isEmpty() != false) return false
        step = Step.REMIND
        return true
    }

    /** Step 8, from step 7. */
    fun toDone() {
        if (done != null) step = Step.DONE
    }

    // Leaving ----------------------------------------------------------------------------

    /** "取消" on the panel of a tap. */
    fun cancelTap() {
        flow?.cancelTap()
    }

    /** "取消" of steps 4 and 5, "回到開頭", "完成" of step 8: drops the PIN and everything else; back to step 1. */
    fun cancel() {
        dropAll()
        askConfigAgain()
        step = Step.BEFORE
        opened()
    }

    /** A stop outside the lists: the card proof is over. The counts are told why, unless the flow told them already. */
    private fun stopped(stop: Stop) {
        flow?.end(stop)
        dropAll()
        notice = if (stop.code == "idle") copy.say("app_before.idle") else null
        askConfigAgain()
        step = Step.BEFORE
        opened()
    }

    /**
     * A tap that found what stands in the place of step 1: this build went past the server's minimum version since step 1
     * asked, or the phone has no NFC. Everything is dropped, back to step 1, which is replaced ([gate]). False for any other stop.
     */
    private fun replacesStepOne(stop: Stop): Boolean {
        when {
            stop.code == "min_app" -> minApp = MinApp.TooOld(stop.values.getValue("from"))
            stop.code == "card" && stop.values["reason"] == CardException.Reason.NO_NFC.name -> hasNfc = false
            else -> return false
        }
        dropAll()
        step = Step.BEFORE
        opened()
        return true
    }

    /**
     * The PIN has been on the phone for [CardProof.IDLE_MS], typed or waiting for the last tap: dropped with the card proof, back
     * to step 1, with the reason. Not in the middle of a tap that began in time: that tap is made.
     */
    fun checkIdle() {
        if (panel != null) return
        if (flow?.idleExpired() == true || pinExpired()) stopped(Stop("idle"))
    }

    private fun dropAll(keepDone: Boolean = false) {
        flow?.cancel()
        flow = null
        panel = null
        senseDemo = null
        pin.clear()
        keptPinSince = null
        pinBusy = null
        pinMessage = null
        pinRetry = false
        submitTurnedAway = false
        // A start whose answer will not be told any more (step() tells only the card proof that is there): 下一步 is pressed again.
        starting = false
        name = ""
        status = null
        hangFromLimit = false
        accountsMode = AccountsMode.OPEN
        fields.clear()
        rowMessages.clear()
        listMessage = null
        consequence = null
        if (!keepDone) {
            done = null
            single = null
            hangWhole = false
            hangDemo = null
        }
    }

    private companion object {
        /** How long the panel says the card can be taken away before it closes. */
        const val PANEL_DONE_MS = 1200L
    }
}
