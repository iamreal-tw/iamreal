package tw.iamreal.app.ui

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
import tw.iamreal.app.flow.Platforms
import tw.iamreal.app.flow.Stop
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

/** The buttons under step 5's list when it stopped. */
internal enum class ProgressButton { NONE, TAP_AGAIN, RESTART }

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
 * Step 5's button after a stop. The tap did not get to a signature: the PIN is still there, and the tap is made again. A PIN
 * the card refused, a card that is locked, a card the secure channel cannot be made with: the flow dropped the PIN with
 * everything else, and the only way on is back to the beginning; so for any stop of the server, `paused` among them.
 */
internal fun progressButtonAfter(stop: Stop): ProgressButton {
    val again = stop.code == "other_card" || (stop.code == "card" && stop.values["reason"] !in CardProof.ENDS_AT_LAST_TAP)
    return if (again) ProgressButton.TAP_AGAIN else ProgressButton.RESTART
}

/**
 * The PIN as it is typed: characters in an array this class overwrites,
 * never a String of the app's. It is in memory only: not in the saved
 * state of the activity, not in any file.
 */
internal class PinField {
    private val chars = CharArray(MAX)
    var length by mutableIntStateOf(0)
        private set

    fun append(c: Char) {
        // What a card's PIN can be made of: printable ASCII.
        if (length < MAX && c in '!'..'~') chars[length++] = c
    }

    fun removeLast() {
        if (length > 0) chars[--length] = 0.toChar()
    }

    fun clear() {
        chars.fill(0.toChar())
        length = 0
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
internal class Model(private val wiring: Wiring, private val bundled: (String) -> ByteArray, private val crlNumbers: CardProof.CrlNumbers, val copy: Copy) {
    val messages = Messages(copy)
    private val backend = Backend(wiring.site, wiring.data)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "card-proof") }
    private var flow: CardProof? = null

    var step by mutableStateOf(Step.BEFORE)
        private set

    /**
     * The operator stopped taking card proofs, as the server's config last said (docs/api/card-proof.md, `paused`): step 1
     * says so in place of its button. Until the config answers, and when it does not: false, and step 2 asks again.
     */
    var paused by mutableStateOf(false)
        private set

    /** Above step 1: why the card proof came back to it. */
    var notice by mutableStateOf<String?>(null)
        private set

    /** The panel of a tap, or null. */
    var panel by mutableStateOf<CardProof.Tap?>(null)
        private set

    // Step 2
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
    val pin = PinField()
    var pinBusy by mutableStateOf<String?>(null)
        private set
    var pinMessage by mutableStateOf<String?>(null)
        private set

    /** What step 3 says under the PIN's field. "請輸入 PIN。" and the sentence of the PIN's form only while the field is empty (design/copy/card-proof.md, "3. 輸入 PIN", app). */
    val pinNote: String? get() = pinMessage?.takeUnless { (it == copy.say("app_pin.need_pin") || it == copy.say("app_pin.pin_format")) && pin.length > 0 }

    /** The card proof ended while the PIN was asked for: the only way on is to read the card again. */
    var pinEnded by mutableStateOf(false)
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

    // Steps 6 to 8
    var done by mutableStateOf<CardProof.Done?>(null)
        private set

    /** Step 6 is the whole one: "沒有看到連結，重新掛上" was pressed on the short one. */
    var hangWhole by mutableStateOf(false)
        private set
    var single by mutableStateOf<String?>(null)
        private set

    val domain: String get() = wiring.domain

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
            // Not when it was asked again meanwhile: the later answer says.
            main.post { if (synchronized(this@Model) { config === it }) paused = said }
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

    private fun newFlow(): CardProof {
        flow?.cancel()
        return CardProof(object : CardProof.Deps {
            override val backend = this@Model.backend
            override val card = wiring.card
            override fun config() = awaitConfig()
            override fun openSession() = wiring.openSession()
            override fun bundled(name: String) = this@Model.bundled(name)
            override fun now() = System.currentTimeMillis()
            override val crlNumbers = this@Model.crlNumbers
        }).also { flow = it }
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
                f.cancel()
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
                if (panel == CardProof.Tap.SIGNED && pinBusy != null) pinBusy = copy.say("app_pin.signed")
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

    fun start() {
        notice = null
        toRead()
    }

    // Step 2 ---------------------------------------------------------------------------

    /** Step 2 with nothing read: a new card proof. */
    private fun toRead() {
        dropAll()
        newFlow()
        readItems = items(4, 0, false)
        readMessage = null
        readButton = ReadButton.TAP
        readBusy = false
        step = Step.READ
    }

    /** Step 1 in front again while it says card proofs are stopped: asks the server whether they still are. */
    fun checkPaused() {
        if (step == Step.BEFORE && paused) synchronized(this) { if (config.isDone) config = askConfig() }
    }

    fun backToBefore() {
        dropAll()
        step = Step.BEFORE
    }

    /** "感應卡片", and "再感應一次": the tap of step 2, on the card proof that is there. */
    fun tapToRead() {
        val f = flow ?: return
        var doneCount = 0
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
        toRead()
        tapToRead()
    }

    fun toPin() {
        pin.clear()
        pinBusy = null
        pinMessage = null
        pinEnded = false
        step = Step.PIN
    }

    // Step 3 ---------------------------------------------------------------------------

    /** "上一步" of step 3: the card is read again, a new card proof. */
    fun backToRead() = toRead()

    fun confirmCard() {
        val f = flow ?: return
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
            { status ->
                pin.clear()
                pinBusy = null
                showAccounts(status)
                main.postDelayed({ checkIdle() }, CardProof.IDLE_MS)
            },
            { stop ->
                pinBusy = null
                pinMessage = messages.stop(stop, Messages.At.PIN)
                val reason = stop.values["reason"]
                when {
                    // The card did not take the PIN, or may have: it is typed again (never sent again by itself).
                    // Nor is it kept for a card the secure channel cannot be made with: the sentence sends the cardholder to a card reader,
                    // and another tap needs the PIN typed again (design/copy/card-proof.md, "3. 輸入 PIN", app).
                    stop.code == "card" && reason in setOf(CardException.Reason.PIN_INCORRECT.name, CardException.Reason.PIN_MAYBE_SENT.name, CardException.Reason.CHANNEL.name) -> pin.clear()
                    // A locked card takes no PIN: the card proof is over.
                    stop.code == "card" && reason == CardException.Reason.LOCKED.name -> {
                        pin.clear()
                        pinEnded = true
                    }
                    // The PIN did not reach a card, or the tap was cancelled: the same PIN, the tap again.
                    stop.code == "card" || stop.code == "other_card" -> {
                        if (pinMessage == null && reason != CardException.Reason.CANCELLED.name) pinMessage = copy.say("common.halted")
                    }
                    else -> {
                        pin.clear()
                        pinEnded = true
                        if (pinMessage == null) pinMessage = copy.say("common.halted")
                    }
                }
            },
        )
    }

    // Step 4 ---------------------------------------------------------------------------

    private fun showAccounts(status: CardProof.Status) {
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

    /** "不改了": back to what the card declares, nothing typed kept. */
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
        var doneCount = 0
        progressItems = items(4, 0, true)
        progressMessage = null
        progressRequestId = null
        progressButton = ProgressButton.NONE
        signed = false
        step = Step.PROGRESS
        step(
            f,
            {
                f.declare(events(f) {
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
                // Everything withdrawn: nothing to hang, to be reminded of or to share.
                step = if (done.accounts.isEmpty()) Step.DONE else Step.HANG
            },
            { stop ->
                if (stop.code == "idle") return@step stopped(stop)
                progressItems = items(4, doneCount, false, halted = true)
                progressMessage = messages.stop(stop, Messages.At.DECLARE)
                progressRequestId = stop.requestId
                progressButton = progressButtonAfter(stop)
            },
        )
    }

    // Steps 6 to 8 -----------------------------------------------------------------------

    /** "沒有看到連結，重新掛上": step 6 still, the whole of it. */
    fun hangAgain() {
        hangWhole = true
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
        step = Step.BEFORE
    }

    /** A stop outside the lists: the card proof is over. */
    private fun stopped(stop: Stop) {
        dropAll()
        notice = if (stop.code == "idle") copy.say("app_before.idle") else null
        step = Step.BEFORE
    }

    /** The PIN has waited [CardProof.IDLE_MS] for the last tap: dropped, back to step 1, with the reason. */
    fun checkIdle() {
        if (flow?.idleExpired() == true) stopped(Stop("idle"))
    }

    private fun dropAll(keepDone: Boolean = false) {
        flow?.cancel()
        flow = null
        panel = null
        pin.clear()
        pinBusy = null
        pinMessage = null
        name = ""
        status = null
        accountsMode = AccountsMode.OPEN
        fields.clear()
        rowMessages.clear()
        listMessage = null
        consequence = null
        if (!keepDone) {
            done = null
            single = null
            hangWhole = false
        }
    }

    private companion object {
        /** How long the panel says the card can be taken away before it closes. */
        const val PANEL_DONE_MS = 1200L
    }
}
