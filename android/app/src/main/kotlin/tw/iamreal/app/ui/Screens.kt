package tw.iamreal.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.flow.Platforms

/** What a screen asks of the phone: an address opened outside the app, a text put on the clipboard. */
internal class Outside(val open: (String) -> Unit, val copy: (String) -> Unit)

/**
 * The six steps (design/copy/card-proof.md, issue #134), one screen each,
 * and the panel of a tap over them. Every sentence is the copy's; which one
 * is [Messages]'s and [Model]'s to say.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun CardProofScreens(m: Model, outside: Outside) = WithColours {
    val c = LocalColours.current
    // The tags below are the names a test finds the fields by.
    Box(Modifier.fillMaxSize().background(c.paper).safeDrawingPadding().imePadding().semantics { testTagsAsResourceId = true }) {
        // Each step starts at its top.
        key(m.step) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp).testTag("step-${m.step.name.lowercase()}"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Small(m.copy.say("common.service_name"))
                Small(m.copy.say("common.step", "step" to m.step.number, "steps" to 6))
                when (m.step) {
                    Step.BEFORE -> Before(m)
                    Step.READ -> Read(m)
                    Step.PIN -> Pin(m, outside)
                    Step.ACCOUNTS -> Accounts(m, outside)
                    Step.CONFIRM -> Confirm(m)
                    Step.PROGRESS -> Progress(m, outside)
                    Step.DONE -> Done(m, outside)
                }
                Spacer(Modifier.height(24.dp))
            }
        }
        m.panel?.let { TapPanel(m, it) }
    }
}

@Composable
private fun Before(m: Model) {
    val c = m.copy
    m.notice?.let { Problem(it) }
    Title(c.say("before.title"))
    Lead(c.say("before.prepare_card"))
    Body(c.say("before.citizens_only"))
    // The app knows one platform: the sentence names it.
    Lead(c.say("before.one_proof_single", "platform" to Platforms.THREADS.name))
    Question(c.say("before.why_physical"), c.say("before.why_physical_card"), c.say("before.why_physical_mobile"))
    Question(c.say("before.how_to_get"), c.say("before.how_to_get_counter"), c.say("before.how_to_get_moica"))
    Actions { Button(c.say("common.next"), primary = true) { m.start() } }
}

@Composable
private fun Read(m: Model) {
    val c = m.copy
    Title(c.say("read.title"))
    Lead(if (m.readButton == ReadButton.NEXT) c.say("app_read.lift") else c.say("app_read.how", "spot" to c.say("app_read.spot_android")))
    TaskList(c, listOf(c.say("read.server"), c.say("app_read.certificate"), c.say("read.check"), c.say("read.crl")), m.readItems, m.readMessage, "read-list")
    Actions {
        when (m.readButton) {
            ReadButton.TAP -> {
                Button(c.say("common.back"), enabled = !m.readBusy) { m.backToBefore() }
                Button(c.say("app_read.tap_card"), primary = true, enabled = !m.readBusy) { m.tapToRead() }
            }
            ReadButton.TAP_AGAIN -> Button(c.say("app_read.tap_again"), primary = true) { m.tapToRead() }
            ReadButton.RESTART -> Button(c.say("app_read.restart"), primary = true) { m.readAgain() }
            ReadButton.NEXT -> {
                Button(c.say("common.back")) { m.backToBefore() }
                Button(c.say("common.next"), primary = true) { m.toPin() }
            }
        }
    }
}

@Composable
private fun Pin(m: Model, outside: Outside) {
    val c = m.copy
    val busy = m.pinBusy != null
    Title(c.say("pin.title"))
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Small(c.say("pin.card_read"))
        Lead(m.name, Modifier.testTag("card-name"))
        Small(c.say("pin.name_note"))
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Body(c.say("pin.label"))
        PinInput(m.pin, enabled = !busy && !m.pinEnded, tag = "pin", modifier = Modifier.weight(1f))
    }
    m.pinMessage?.let { Problem(it) }
    Point(c.say("pin.purpose"))
    Point(c.say("app_pin.stays"))
    Point(c.say("pin.card_and_pin"))
    TextButton(c.say("links.more")) { outside.open(m.helpUrl("more")) }
    if (busy && m.pinBusy != "") Small(m.pinBusy!!)
    Actions {
        if (m.pinEnded) {
            Button(c.say("app_read.restart"), primary = true) { m.readAgain() }
        } else {
            Button(c.say("common.back"), enabled = !busy) { m.backToRead() }
            Button(c.say("pin.confirm_card"), primary = true, enabled = !busy) { m.confirmCard() }
        }
    }
}

/** One of the points under a screen's main part. */
@Composable
private fun Point(text: String) = Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    Body("·")
    Body(text)
}

@Composable
private fun Accounts(m: Model, outside: Outside) {
    val c = m.copy
    val status = m.status ?: return
    val single = m.single
    Title(if (single != null) c.say("accounts.title_single", "platform" to single) else c.say("accounts.title"))
    for (line in m.messages.accountsLead(status, single)) Lead(line)
    for (slot in status.slots) {
        val presentation = if (slot.known) Platforms.of(slot.platform) else null
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Body(presentation?.name ?: slot.platform, Modifier.width(64.dp))
                if (presentation == null || status.dailyLimit) {
                    // Kept as it is, or a day with 3 records: shown, not changed.
                    Body((presentation?.prefix ?: "") + (slot.current ?: ""), Modifier.testTag("account-${slot.platform}"))
                } else {
                    Body(presentation.prefix)
                    AccountField(m.fields[slot.platform] ?: "", enabled = true, tag = "account-${slot.platform}", modifier = Modifier.weight(1f)) {
                        m.fields[slot.platform] = it
                    }
                    Button(c.say("app_accounts.preview")) { m.previewUrl(slot.platform)?.let(outside.open) }
                }
            }
            if (!status.dailyLimit) for (line in m.messages.rowLines(slot)) Small(line)
            m.rowMessages[slot.platform]?.let { Problem(it) }
        }
    }
    if (status.dailyLimit) {
        Lead(c.say("stops.daily_limit"))
        Actions { Button(c.say("accounts.restart"), primary = true) { m.cancel() } }
        return
    }
    for ((note, more) in m.messages.accountsNotes(status, single)) {
        Body(note)
        if (more) TextButton(c.say("links.more")) { outside.open(m.helpUrl("more")) }
    }
    m.listMessage?.let { Problem(it) }
    Actions { Button(c.say("common.next"), primary = true) { m.toConfirm() } }
    Body(c.say("accounts.no_check"))
    Body(c.say("accounts.acknowledged"))
    TextButton(c.say("links.more")) { outside.open(m.helpUrl("more")) }
    TextButton(c.say("common.cancel")) { m.cancel() }
}

/** A row of a list of accounts: the platform, the account, and under it what is said of it. */
@Composable
private fun ListRow(name: String, value: String, under: String? = null, tag: String? = null) = ListRow(name, value, listOfNotNull(under), tag)

/** As above, with a line for each thing said of the account. */
@Composable
private fun ListRow(name: String, value: String, under: List<String>, tag: String? = null) = Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    Body(name, Modifier.width(72.dp))
    Column(if (tag != null) Modifier.testTag(tag) else Modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Body(value)
        for (line in under) Small(line)
    }
}

@Composable
private fun Boxed(content: @Composable () -> Unit) =
    Column(Modifier.fillMaxWidth().border(1.dp, LocalColours.current.ink, RoundedCornerShape(8.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }

private fun rowName(platform: String, known: Boolean): String = (if (known) Platforms.of(platform)?.name else null) ?: platform

private fun rowAccount(platform: String, known: Boolean, username: String): String = if (known) Platforms.handle(platform, username) else username

@Composable
private fun Confirm(m: Model) {
    val c = m.copy
    val q = m.consequence ?: return
    val status = m.status ?: return
    val single = m.single
    val empty = q.accounts.isEmpty()
    Title(c.say("confirm.title"))
    Lead(if (empty) c.say("confirm.intro_withdraw_all") else if (single != null) c.say("confirm.intro_single") else c.say("confirm.intro"))
    Boxed {
        for (row in q.rows) ListRow(rowName(row.platform, row.known), rowAccount(row.platform, row.known, row.username), m.messages.rowSentences(row), "confirm-${row.platform}")
        ListRow(c.say("confirm.date"), q.today)
        ListRow(c.say("confirm.short_id_label"), c.say("confirm.short_id", "short_id" to status.shortId))
    }
    if (q.rows.any { it.kind == "withdraw" }) Body(c.say("confirm.withdraw_stays"))
    if (!empty) Lead(if (single != null) c.say("confirm.listed_single", "platform" to single) else c.say("confirm.listed_together"))
    Point(c.say("confirm.no_identity"))
    Point((if (empty) c.say("confirm.later_withdraw") else c.say("confirm.later")) + c.say("confirm.permanent"))
    Actions {
        Button(c.say("common.back")) { m.backToAccounts() }
        Button(m.messages.confirmButton(q, single), primary = true) { m.declare() }
    }
    TextButton(c.say("common.cancel")) { m.cancel() }
}

@Composable
private fun Progress(m: Model, outside: Outside) {
    val c = m.copy
    Title(c.say("progress.title"))
    Lead(c.say("app_progress.keep_open"))
    if (m.signed) Lead(c.say("app_read.lift"))
    TaskList(
        c,
        listOf(c.say("progress.server"), c.say("app_progress.sign"), c.say("app_progress.compute", "seconds" to COMPUTE_SECONDS), c.say("progress.submit")),
        m.progressItems, m.progressMessage, "progress-list",
    )
    m.progressRequestId?.let { Small(c.say("stops.request_id", "request_id" to it)) }
    if (m.progressItems[2] == ItemState.NOW) {
        Body(c.say("progress.zero_knowledge"))
        TextButton(c.say("links.more")) { outside.open(m.helpUrl("more")) }
    }
    when (m.progressButton) {
        ProgressButton.NONE -> {}
        ProgressButton.TAP_AGAIN -> {
            Actions { Button(c.say("app_read.tap_again"), primary = true) { m.declare() } }
            TextButton(c.say("common.cancel")) { m.cancel() }
        }
        ProgressButton.RESTART -> Actions { Button(c.say("accounts.restart"), primary = true) { m.cancel() } }
    }
}

@Composable
private fun Done(m: Model, outside: Outside) {
    val c = m.copy
    val d = m.done ?: return
    val single = m.single
    val withdrawAll = d.accounts.isEmpty()
    val url = m.proofUrl(d.shortId)
    val link = "${m.domain}/p/${d.shortId}"
    var copied by remember { mutableStateOf(false) }
    val view = m.messages.done(d, single)

    // What the roster recorded is not what step 5 said: first of all, above the title.
    view.mismatch?.let { Problem(it, Modifier.testTag("done-mismatch")) }
    Title(m.messages.doneTitle(d))
    if (!withdrawAll) {
        Boxed {
            Heading(c.say("done.proof"))
            for (row in d.expected) if (row.kind != "withdraw") ListRow(rowName(row.platform, row.known), rowAccount(row.platform, row.known, row.username), tag = "proof-${row.platform}")
            ListRow(c.say("confirm.date"), d.date)
            ListRow(c.say("confirm.short_id_label"), c.say("confirm.short_id", "short_id" to d.shortId))
            Small(c.say("done.hand_ai"))
            Small(c.say("done.hand_profile"))
        }
        Heading(c.say("done.put_up"))
        Body(if (single != null) c.say("done.put_link_single", "platform" to single) else c.say("done.put_link"))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Lead(link, Modifier.weight(1f).testTag("proof-link"))
            Button(if (copied) c.say("done.copied") else c.say("done.copy")) {
                outside.copy(url)
                copied = true
            }
        }
        Actions { Button(c.say("app_done.open_platform", "platform" to Platforms.THREADS.name)) { outside.open(Platforms.THREADS.home) } }
        Small(c.say("app_done.how_to_put", "platform" to Platforms.THREADS.name))
        if (d.firstRecord) Body(c.say("done.new_card"))
        if (view.withdrawnLink) Body(c.say("done.withdrawn_link"))
        TextButton(c.say("links.proof")) { outside.open(url) }
    }

    // The record, as the confirmation screen said it would be. What the server says it recorded on each
    // platform, and whether it differs, is not shown yet (issue #221).
    Heading(c.say("done.recorded"))
    Body(d.date)
    view.record?.let { Body(it) }
    view.kindsUnreadable?.let { Body(it, Modifier.testTag("done-kinds-unreadable")) }
    for (row in view.rows) {
        ListRow(rowName(row.platform, row.known), rowAccount(row.platform, row.known, row.username), listOfNotNull(row.kind, row.expected, row.switchUsed), "recorded-${row.platform}")
    }
    if (view.kindsUnreadable == null) Body(c.say("done.short_id", "short_id" to d.shortId))
    for (sentence in view.otherCards) Small(sentence)
    if (!withdrawAll) {
        Point(if (single != null) c.say("done.advice_single") else c.say("done.advice"))
        Point(c.say("done.renamed"))
    }
    Point(c.say("done.trust"))
    TextButton(c.say("links.verify")) { outside.open(m.helpUrl("verify")) }
    Actions { Button(c.say("done.restart"), primary = true) { m.cancel() } }
}

/** The panel of a tap, from the bottom of the screen (design/copy/card-proof.md, "app：感應的面板"). */
@Composable
private fun TapPanel(m: Model, tap: CardProof.Tap) {
    val c = m.copy
    val colours = LocalColours.current
    // What is under the panel takes no press while it is up.
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}, contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier.fillMaxWidth().background(colours.paper, RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)).padding(24.dp).testTag("tap-panel"),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (tap) {
                CardProof.Tap.WAITING -> {
                    Heading(c.say("app_panel.android_wait_title"))
                    Body(c.say("app_panel.android_wait"))
                    Actions { Button(c.say("common.cancel")) { m.cancelTap() } }
                }
                CardProof.Tap.READING -> {
                    Heading(c.say("app_panel.android_busy_title"))
                    Body(c.say("app_panel.reading"))
                    Actions { Button(c.say("common.cancel")) { m.cancelTap() } }
                }
                CardProof.Tap.SIGNING -> {
                    Heading(c.say("app_panel.android_busy_title"))
                    Body(c.say("app_panel.signing"))
                    Actions { Button(c.say("common.cancel")) { m.cancelTap() } }
                }
                CardProof.Tap.READ -> {
                    Heading(c.say("app_panel.android_done_title"))
                    Body(c.say("app_panel.read"))
                }
                CardProof.Tap.SIGNED -> {
                    Heading(c.say("app_panel.android_done_title"))
                    Body(c.say("app_panel.signed"))
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** The seconds step 5 says the proof takes on Android (design/copy/card-proof.md, "5. 確認", app). */
private const val COMPUTE_SECONDS = 10
