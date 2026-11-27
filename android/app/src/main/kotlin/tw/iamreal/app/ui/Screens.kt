package tw.iamreal.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import tw.iamreal.app.Environment
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.flow.MinApp
import tw.iamreal.app.flow.Platforms
import tw.iamreal.app.ui.demo.HangDemo
import tw.iamreal.app.ui.demo.HangDemoWords
import tw.iamreal.app.ui.demo.SenseDemo

/**
 * What a screen asks of the phone: an address opened outside the app (false when no app on the phone opens it), a text put on the clipboard,
 * a text handed to the system's share sheet.
 */
internal class Outside(
    val open: (String) -> Boolean,
    val copy: (String) -> Unit,
    val share: (String) -> Unit,
    val nfcSettings: () -> Unit,
    /** The system's page of the app's notifications. */
    val notificationSettings: () -> Unit,
)

/**
 * The eight steps (design/copy/card-proof.md), one screen each, laid out
 * after design/screens/card-proof-app-*, and the panel of a tap over them.
 * Every sentence is the copy's; which one is [Messages]'s and [Model]'s to
 * say. No screen links to a page of the site but steps 6 and 8, whose links
 * are the card's own page and the platform's; step 1's two links are for someone
 * without a card yet, who gets no further, and step 4's link to the card's page
 * for a card that cannot go on today (docs/design/principles.md, 1).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun CardProofScreens(m: Model, r: ReminderModel, outside: Outside) {
    // The tags below are the names a test finds the fields by.
    Box(Modifier.fillMaxSize().background(Colours.bg).safeDrawingPadding().imePadding().semantics { testTagsAsResourceId = true }) {
        Column(Modifier.fillMaxSize()) {
            // The settings from the first and the last step (design/copy/app.md, "設定"): not while a card proof is under way.
            val settings = m.step == Step.BEFORE || m.step == Step.DONE
            Header(m.copy.say("common.service_name"), if (settings) r.app.say("settings.open") else null) { r.openSettings() }
            // Each step starts at its top, and so does the whole step 6 shown from step 4.
            key(m.step, m.hangFromLimit) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Type.gutter).padding(top = 28.dp, bottom = 48.dp).testTag("step-${m.step.name.lowercase()}"),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    // What stands in the place of step 1 has no step bar and nothing above it (design/screens/app-update-required-phone.png, app-no-nfc-phone.png).
                    val gate = if (m.step == Step.BEFORE) m.gate else null
                    if (m.step == Step.BEFORE && gate == null) {
                        // Why the card proof came back to step 1: at the very top (design/copy/card-proof.md, "1. 開始之前", app).
                        m.notice?.let { Problem(it) }
                        // The minimum version's sentence is above everything of step 1, the reminder's too (design/screens/app-update-soon-phone.png).
                        (m.minApp as? MinApp.Until)?.let { UpdateSoon(m, it.from, outside) }
                        // Opened from the reminder's notification (design/screens/app-reminder-4-from-notification-phone.png).
                        FromReminder(r)
                    }
                    // Out of the 8 steps: the whole of step 6 from step 4's daily limit.
                    if (gate == null && !m.hangFromLimit) {
                        StepBar(m.copy, m.step.number)
                        Spacer(Modifier.height(6.dp))
                    }
                    when (m.step) {
                        Step.BEFORE -> when (gate) {
                            Gate.NO_NFC -> NoNfc(m)
                            Gate.TOO_OLD -> TooOld(m, (m.minApp as MinApp.TooOld).from, outside)
                            null -> Before(m, outside)
                        }
                        Step.READ -> Read(m, outside)
                        Step.PIN -> Pin(m)
                        Step.ACCOUNTS -> if (m.hangFromLimit) HangFromLimit(m, outside) else Accounts(m, outside)
                        Step.CONFIRM -> Confirm(m)
                        Step.PROGRESS -> Progress(m)
                        Step.HANG -> Hang(m, outside)
                        Step.REMIND -> RemindStep(r, m.copy, m.done?.validUntil, back = { m.backToHang() }, next = { m.toDone() }, notificationSettings = outside.notificationSettings)
                        Step.DONE -> Finish(m, outside)
                    }
                }
            }
        }
        m.panel?.let { TapPanel(m, it) }
    }
}

/**
 * before.find_office: a search for household registration offices, handed to the phone's map app (`geo:0,0?q=`,
 * https://developer.android.com/guide/components/intents-common#Maps); on a phone without one, the same search on a map's site, as the
 * web's step 1 opens it (https://developers.google.com/maps/documentation/urls/get-started). The words searched for are
 * design/copy/card-proof.md's ("1. 開始之前"), percent-encoded. The app asks for no location: what is near is the map's to tell.
 */
private const val FIND_OFFICE_QUERY = "%E6%88%B6%E6%94%BF%E4%BA%8B%E5%8B%99%E6%89%80"
internal const val FIND_OFFICE_MAP = "geo:0,0?q=$FIND_OFFICE_QUERY"
internal const val FIND_OFFICE_SITE = "https://www.google.com/maps/search/?api=1&query=$FIND_OFFICE_QUERY"

/** before.how_to_get_moica: the certificate authority's page on applying (design/copy/card-proof.md, "1. 開始之前"). */
private const val MOICA = "https://moica.nat.gov.tw/rac.html"

/** The store the app is updated from, as the copy's `{store}` (design/copy/card-proof.md: on Android, Google Play). */
private const val STORE = "Google Play"

/** The room above a screen that stands in the place of step 1, where the step bar is not (design/screens/app-update-required-phone.png). */
private val GATE_TOP = 56.dp

/** Above step 1 while this version still does card proofs and will not from [from] on (design/copy/card-proof.md, "1. 開始之前", app). */
@Composable
private fun UpdateSoon(m: Model, from: String, outside: Outside) {
    val c = m.copy
    Column(
        Modifier.fillMaxWidth().background(Colours.soft, RoundedCornerShape(Type.radiusPanel)).padding(16.dp).testTag("update-soon"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        BasicText(c.say("app_before.update_soon", "min_app_from" to from, "store" to STORE), style = TextStyle(color = Colours.ink, fontSize = 15.sp, lineHeight = 1.75.em))
        // The app's own page on Google Play (Environment.kt); the development build has none, and no button.
        Environment.STORE_PAGE?.let { page -> Button(c.say("app_before.update", "store" to STORE), Modifier.fillMaxWidth(), height = 44.dp) { outside.open(page) } }
    }
}

/** In place of step 1 from the date the minimum version starts on: nothing of a card proof can be reached. */
@Composable
private fun TooOld(m: Model, from: String, outside: Outside) {
    val c = m.copy
    Spacer(Modifier.height(GATE_TOP))
    Title(c.say("app_before.too_old_title"))
    Body(c.say("app_before.too_old", "min_app_from" to from))
    Body(c.say("app_before.nothing_sent"))
    Environment.STORE_PAGE?.let { page -> Actions { Button(c.say("app_before.update", "store" to STORE), Modifier.fillMaxWidth(), primary = true) { outside.open(page) } } }
    Small(c.say("app_before.or_reader", "domain" to m.domain))
}

/** In place of step 1 on a phone without NFC: nothing of a card proof can be reached. */
@Composable
private fun NoNfc(m: Model) {
    val c = m.copy
    Spacer(Modifier.height(GATE_TOP))
    Title(c.say("app_before.no_nfc_title"))
    Body(c.say("app_before.no_nfc"))
    Body(c.say("app_before.no_nfc_reader", "domain" to m.domain))
}

@Composable
private fun Before(m: Model, outside: Outside) {
    val c = m.copy
    Title(c.say("before.title"))
    Body(c.say("before.prepare_card"), strong = true)
    Body(c.say("before.citizens_only"))
    // With one platform nothing more: what the proof says, and that it is public, is step 5's to say.
    for (line in m.messages.beforeSeveral()) Body(line)
    // The operator stopped taking card proofs: said here, before a card is read, in place of common.next (card-proof.md, step 1).
    if (m.paused) {
        Problem(c.say("before.paused"))
    } else {
        // Too many people now: above common.next, which stays to be pressed again (card-proof.md, step 1, 人太多的時候).
        if (m.startTurnedAway) Problem(c.say("before.busy"))
        Actions { Button(c.say("common.next"), Modifier.fillMaxWidth(), primary = true, enabled = !m.starting) { m.start() } }
    }
    Questions {
        Question(c.say("before.why_physical")) {
            Answer(c.say("before.why_physical_card"))
            Answer(c.say("before.why_physical_mobile"))
        }
        Question(c.say("before.how_to_get")) {
            Answer(c.say("before.how_to_get_counter"))
            // Nothing of a card proof goes with either: there is none yet.
            Button(c.say("before.find_office"), Modifier.fillMaxWidth().testTag("find-office"), height = 46.dp) {
                if (!outside.open(FIND_OFFICE_MAP)) outside.open(FIND_OFFICE_SITE)
            }
            Link(c.say("before.how_to_get_moica"), Modifier.padding(top = 4.dp, bottom = 8.dp), size = 15.sp) { outside.open(MOICA) }
        }
    }
}

@Composable
private fun Read(m: Model, outside: Outside) {
    val c = m.copy
    Title(c.say("read.title"))
    if (m.readButton == ReadButton.NEXT) {
        Body(c.say("app_read.lift"), strong = true)
    } else {
        // Where the card goes differs from one Android phone to another: the words and the demonstration say to look for it.
        Body(c.say("app_read.how_android"))
        m.senseDemo?.let { demo ->
            // Not while the card is being read: the demonstration rests then.
            DemoFrame(demo, c, "sense-demo-button", enabled = !m.readBusy) {
                SenseDemo(demo, c.say("app_demo.sense_android"), it)
            }
        }
    }
    val list = @Composable { TaskList(c, listOf(c.say("read.server"), c.say("app_read.certificate"), c.say("read.check"), c.say("read.crl")), m.readItems, m.readMessage, "read-list") }
    // Before the card is read, "感應卡片" right under the demonstration, where it is seen without scrolling, and the list, all
    // still to do, under it. Once the list has something to say (where it stopped, why; all done), the list and then the buttons.
    val tapFirst = m.readButton == ReadButton.TAP
    if (!tapFirst) list()
    Actions {
        val wide = Modifier.fillMaxWidth()
        when (m.readButton) {
            ReadButton.TAP -> {
                Button(c.say("app_read.tap_card"), wide, primary = true, enabled = !m.readBusy) { m.tapToRead() }
                Button(c.say("common.back"), wide, enabled = !m.readBusy) { m.backToBefore() }
            }
            ReadButton.TAP_AGAIN -> Button(c.say("app_read.tap_again"), wide, primary = true) { m.tapToRead() }
            ReadButton.NFC -> {
                Button(c.say("app_read.nfc_settings"), wide, primary = true) { outside.nfcSettings() }
                Button(c.say("app_read.nfc_retry"), wide) { m.tapToRead() }
            }
            ReadButton.RESTART -> Button(c.say("app_read.restart"), wide, primary = true) { m.readAgain() }
            ReadButton.NEXT -> {
                Button(c.say("common.next"), wide, primary = true) { m.toPin() }
                Button(c.say("common.back"), wide) { m.backToBefore() }
            }
        }
    }
    if (tapFirst) list()
}

@Composable
private fun Pin(m: Model) {
    val c = m.copy
    val busy = m.pinBusy != null
    Title(c.say("pin.title"))
    // What was read from the card, shown only here: a box of its own.
    Column(Modifier.fillMaxWidth().padding(top = 8.dp).background(Colours.soft, RoundedCornerShape(Type.radiusPanel)).padding(horizontal = 20.dp, vertical = 18.dp)) {
        Small(c.say("pin.card_read"))
        // The system's typeface, not the headings': that one is a subset of the words of design/copy/, and a name has others (design/DESIGN.md, "字").
        BasicText(m.name, Modifier.testTag("card-name"), style = TextStyle(color = Colours.ink, fontSize = Type.sizeH3, lineHeight = Type.leadingH3, fontWeight = Type.weightHeading))
        Small(c.say("pin.name_note"))
    }
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Subhead(c.say("pin.label"))
        PinInput(m.pin, enabled = !busy && !m.pinEnded && !m.pinKept && !m.pinRetry, tag = "pin", modifier = Modifier.fillMaxWidth())
    }
    m.pinNote?.let { Problem(it) }
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Point(c.say("pin.purpose"))
        Point(c.say("app_pin.stays"))
    }
    if (busy && m.pinBusy != "") Small(m.pinBusy!!)
    Actions {
        val wide = Modifier.fillMaxWidth()
        if (m.pinEnded) {
            Button(c.say("app_read.restart"), wide, primary = true) { m.readAgain() }
        } else if (m.pinRetry) {
            // The card signed; the server turned its state away as too many: asked again, the card not held to the phone again.
            Button(c.say("progress.retry"), wide, primary = true, enabled = !busy) { m.retryCardState() }
            Button(c.say("common.back"), wide, enabled = !busy) { m.backToRead() }
        } else if (m.pinKept) {
            Button(c.say("app_read.tap_again"), wide, primary = true, enabled = !busy) { m.confirmCard() }
            Button(c.say("common.back"), wide, enabled = !busy) { m.backToRead() }
        } else {
            Button(c.say("pin.confirm_card"), wide, primary = true, enabled = !busy) { m.confirmCard() }
            Button(c.say("common.back"), wide, enabled = !busy) { m.backToRead() }
        }
    }
}

/** Step 4 (design/copy/card-proof.md, "4. 你的帳號"): the screen for what the card declares, and for what was pressed on it. Whichever, step 5 is next. */
@Composable
private fun Accounts(m: Model, outside: Outside) {
    val status = m.status ?: return
    when (m.accountsMode) {
        AccountsMode.SWITCH -> SwitchAccount(m, m.messages.switchView(status), outside)
        AccountsMode.EDIT -> FillAccounts(m, m.messages.editListView(status), outside)
        AccountsMode.OPEN -> when (val view = m.messages.accountsView(status)) {
            is Messages.FillView -> FillAccounts(m, view, outside)
            is Messages.DeclaredView -> DeclaredAccounts(m, view, outside)
        }
    }
}

/**
 * 3 records of the card today (the PIN already dropped, [Model]): the sentence, a link to the card's page, 重新掛上連結 where the
 * card declares an account the app can hang, and 回到開頭.
 */
@Composable
private fun DailyLimit(m: Model, sentence: String, outside: Outside) {
    val c = m.copy
    val shortId = m.status?.shortId ?: return
    val openProof = c.say("done.open_proof")
    val wide = Modifier.fillMaxWidth()
    Body(sentence, strong = true)
    // Nothing more to do in this card proof today: to the card's page, and how to hang its link, out of the flow
    // (design/copy/card-proof.md, "今天已經過卡 3 次").
    OpensProof(c.say("hang.look", "open_proof" to openProof), openProof) { outside.open(m.proofUrl(shortId)) }
    Actions {
        Button(c.say("accounts.restart"), wide) { m.cancel() }
        if (m.status?.let { m.messages.canHangFromLimit(it) } == true) Button(c.say("hang.rehang"), wide) { m.showHangFromLimit() }
    }
}

/**
 * The whole of step 6 for the accounts the card declares now, from step 4's 今天已經過卡 3 次 by 重新掛上連結: no new record,
 * so no date and no step of the 8; 上一步 back to step 4, 回到開頭 to step 1 (design/copy/card-proof.md, "今天已經過卡 3 次").
 */
@Composable
private fun HangFromLimit(m: Model, outside: Outside) {
    val c = m.copy
    val status = m.status ?: return
    val view = m.messages.hangFromLimit(status, m.single)
    val wide = Modifier.fillMaxWidth()
    HangWhole(m, outside, view.title, view.why, view.profiles, view.steps, view.hung, view.account, emptyList(), status.shortId)
    Actions {
        Button(c.say("accounts.restart"), wide) { m.cancel() }
        Button(c.say("common.back"), wide) { m.backFromHangFromLimit() }
    }
}

/** The card declares accounts: what it declares and when it last did, "更新島民證明", and the other things to do. */
@Composable
private fun DeclaredAccounts(m: Model, view: Messages.DeclaredView, outside: Outside) {
    val c = m.copy
    Title(view.title)
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Body(view.declaredNow)
        for (a in view.current) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (a.name != null) BasicText(a.name, Modifier.width(120.dp).alignByBaseline(), style = TextStyle(color = Colours.mute, fontSize = 15.sp, lineHeight = 1.6.em))
                BasicText(a.account, Modifier.weight(1f).alignByBaseline().testTag("current-${a.platform}"), style = TextStyle(color = Colours.ink, fontSize = Type.sizeH3, lineHeight = Type.leadingH3, fontWeight = Type.weightAccount))
            }
        }
        view.last?.let { Small(it) }
    }
    view.dailyLimit?.let { return DailyLimit(m, it, outside) }
    // Why the list cannot be signed as it is: there is no row here to write it under.
    for (message in m.rowMessages.values + listOfNotNull(m.listMessage)) Problem(message)
    // The main button: the list as it is, nothing to type.
    Actions { Button(view.refresh, Modifier.fillMaxWidth(), primary = true) { m.refresh() } }
    Small(view.refreshNote, colour = Colours.text)
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        view.switchAccount?.let { TextButton(it, action = true) { m.switchAccount() } }
        view.withdraw?.let { TextButton(it, action = true) { m.withdraw() } }
        view.editList?.let { TextButton(it, action = true) { m.editList() } }
    }
    Rule(Modifier.padding(top = 8.dp))
    TextButton(c.say("common.cancel")) { m.cancel() }
}

/** A row of step 4: its platform, the field and "預覽", or the account as it is; what is said of it under it. */
@Composable
private fun AccountRow(m: Model, row: Messages.AccountRow, outside: Outside) = Column(Modifier.fillMaxWidth().padding(vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Subhead(row.name)
    if (!row.editable) {
        // Kept as it is, or a day with 3 records: shown, not changed.
        Body(if (row.current.isEmpty()) "" else row.prefix + row.current, Modifier.testTag("account-${row.platform}"))
    } else {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AccountField(m.fields[row.platform] ?: "", row.prefix, enabled = true, tag = "account-${row.platform}", modifier = Modifier.weight(1f)) {
                m.type(row.platform, it)
            }
            Button(m.copy.say("app_accounts.preview"), height = 52.dp) { m.previewUrl(row.platform)?.let(outside.open) }
        }
    }
    for (line in row.lines) Small(line)
    m.rowMessages[row.platform]?.let { Problem(it) }
}

/** Rows to fill: the card declares nothing (a row filled is a new declaration), or after "修改帳號清單" each row changed on its own. */
@Composable
private fun FillAccounts(m: Model, view: Messages.FillView, outside: Outside) {
    val c = m.copy
    Title(view.title)
    for (line in view.lead) Body(line)
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Rule()
        for (row in view.rows) {
            AccountRow(m, row, outside)
            Rule()
        }
    }
    view.dailyLimit?.let { return DailyLimit(m, it, outside) }
    for (note in view.notes) Small(note, colour = Colours.text)
    m.listMessage?.let { Problem(it) }
    Actions { Button(c.say("common.next"), Modifier.fillMaxWidth(), primary = true) { m.toConfirm() } }
    Rule(Modifier.padding(top = 22.dp))
    if (view.editList) TextButton(c.say("accounts.keep"), action = true) { m.keep() }
    TextButton(c.say("common.cancel")) { m.cancel() }
}

/** After "改成別的帳號" (one platform): the account now, a field for another, what changing it does and what it costs. */
@Composable
private fun SwitchAccount(m: Model, view: Messages.SwitchView, outside: Outside) {
    val c = m.copy
    Title(view.title)
    Body(view.intro)
    if (view.row != null) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            view.heading?.let { Stress(it, Modifier.padding(bottom = 10.dp)) }
            Rule()
            AccountRow(m, view.row, outside)
            Rule()
        }
    }
    Small(view.cost, colour = Colours.text)
    view.previewNote?.let { Small(it, colour = Colours.text) }
    m.listMessage?.let { Problem(it) }
    if (view.row != null) Actions { Button(c.say("common.next"), Modifier.fillMaxWidth(), primary = true) { m.toConfirm() } }
    Rule(Modifier.padding(top = 22.dp))
    TextButton(view.keep, action = true) { m.keep() }
    TextButton(c.say("common.cancel")) { m.cancel() }
}

/** A list of label and value, between lines, under a line in ink: what is about to be recorded, or what was. */
@Composable
private fun Summary(content: @Composable ColumnScope.() -> Unit) = Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
    Rule(colour = Colours.ink, thickness = 1.5.dp)
    content()
}

/** A row of a [Summary]: the label, and the value with a line under it for each thing said of it. */
@Composable
private fun SummaryRow(label: String, value: @Composable () -> Unit, under: List<String> = emptyList(), tag: String? = null) {
    Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        BasicText(label, Modifier.width(80.dp).alignByBaseline(), style = TextStyle(color = Colours.mute, fontSize = 15.sp, lineHeight = 1.6.em))
        Column(Modifier.weight(1f).alignByBaseline().then(if (tag != null) Modifier.testTag(tag) else Modifier), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            value()
            for (line in under) BasicText(line, style = TextStyle(color = Colours.text, fontSize = 15.sp, lineHeight = 1.6.em))
        }
    }
    Rule()
}

@Composable
private fun SummaryValue(text: String, strong: Boolean = false) =
    BasicText(text, style = TextStyle(color = Colours.ink, fontSize = 18.sp, lineHeight = 1.5.em, fontWeight = if (strong) Type.weightHeading else Type.weightBody))

/** "7K2Q9FM4XD 開頭": the short ID in the system's monospace, in one sentence of the copy. */
@Composable
private fun ShortId(sentence: String, shortId: String, size: androidx.compose.ui.unit.TextUnit = 18.sp, colour: Color = Colours.ink) {
    val at = sentence.indexOf(shortId)
    val text = buildAnnotatedString {
        if (at < 0) {
            append(sentence)
        } else {
            append(sentence.substring(0, at))
            withStyle(SpanStyle(fontFamily = Type.mono, letterSpacing = 0.06.em)) { append(shortId) }
            append(sentence.substring(at + shortId.length))
        }
    }
    BasicText(text, style = TextStyle(color = colour, fontSize = size, lineHeight = 1.5.em))
}

private fun rowName(platform: String, known: Boolean): String = (if (known) Platforms.of(platform)?.name else null) ?: platform

private fun rowAccount(platform: String, known: Boolean, username: String): String = if (known) Platforms.handle(platform, username) else username

@Composable
private fun Confirm(m: Model) {
    val c = m.copy
    val q = m.consequence ?: return
    val status = m.status ?: return
    val view = m.messages.confirmView(q, status)
    Title(c.say("confirm.title"))
    Body(view.intro)
    Summary {
        for (row in q.rows) {
            SummaryRow(rowName(row.platform, row.known), { SummaryValue(rowAccount(row.platform, row.known, row.username), strong = true) }, listOf(m.messages.rowSentences(row)), "confirm-${row.platform}")
        }
        SummaryRow(c.say("confirm.date"), { SummaryValue(q.today) })
        SummaryRow(c.say("confirm.short_id_label"), { ShortId(c.say("confirm.short_id", "short_id" to status.shortId), status.shortId) })
    }
    view.withdrawStays?.let { Body(it) }
    // Several platforms: as plain to see as the list, apart from the points. With one, the first sentence says the account is made public.
    view.listedTogether?.let { Stress(it, Modifier.padding(top = 12.dp)) }
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        for (point in view.points) Point(point.text, point.strong)
    }
    Actions {
        Button(view.button, Modifier.fillMaxWidth(), primary = true) { m.declare() }
        Button(c.say("common.back"), Modifier.fillMaxWidth()) { m.backToAccounts() }
    }
    TextButton(c.say("common.cancel")) { m.cancel() }
}

@Composable
private fun Progress(m: Model) {
    val c = m.copy
    Title(c.say("progress.title"))
    Body(c.say("app_progress.keep_open"))
    if (m.signed) Body(c.say("app_read.lift"), strong = true)
    TaskList(
        c,
        listOf(c.say("progress.server"), c.say("app_progress.sign"), c.say("app_progress.compute", "seconds" to COMPUTE_SECONDS), c.say("progress.submit")),
        m.progressItems, m.progressMessage, "progress-list",
    )
    m.progressRequestId?.let { Small(c.say("stops.request_id", "request_id" to it)) }
    when (m.progressButton) {
        ProgressButton.NONE -> {}
        ProgressButton.TAP_AGAIN -> {
            Actions { Button(c.say("app_read.tap_again"), Modifier.fillMaxWidth(), primary = true) { m.declare() } }
            TextButton(c.say("common.cancel")) { m.cancel() }
        }
        // Too many people: the challenge asked for again, or the record sent again; the card is not read again.
        ProgressButton.RETRY -> {
            Actions { Button(c.say("progress.retry"), Modifier.fillMaxWidth(), primary = true) { m.retryDeclare() } }
            TextButton(c.say("common.cancel")) { m.cancel() }
        }
        ProgressButton.RESTART -> Actions { Button(c.say("accounts.restart"), Modifier.fillMaxWidth(), primary = true) { m.cancel() } }
    }
}

/** The card's proof in small (design/DESIGN.md, "證明卡"): the mark, its accounts, how its short ID begins. No red: it is not the card. */
@Composable
private fun SmallCard(c: Copy, accounts: List<Pair<String?, String>>, shortId: String, modifier: Modifier = Modifier) = Column(
    modifier.background(Colours.bg, RoundedCornerShape(Type.radiusPanel)).border(1.5.dp, Colours.ink, RoundedCornerShape(Type.radiusPanel)).padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Logo(Modifier.size(24.dp), animated = true)
        BasicText(c.say("done.proof"), style = TextStyle(color = Colours.ink, fontSize = 15.sp, fontWeight = Type.weightHeading))
    }
    Spacer(Modifier.height(4.dp))
    for ((name, account) in accounts) {
        if (name != null) BasicText(name, style = TextStyle(color = Colours.mute, fontSize = Type.sizeSmall))
        BasicText(account, Modifier.testTag("proof-account"), style = TextStyle(color = Colours.ink, fontSize = Type.sizeH3, lineHeight = 1.2.em, fontWeight = Type.weightAccount))
    }
    ShortId(c.say("confirm.short_id_label") + " " + c.say("confirm.short_id", "short_id" to shortId), shortId, size = Type.sizeSmall, colour = Colours.text)
}

/** "打開你的島民證明看看。": the words that open the card's page in the red of what you do, the rest of the sentence as the body. */
@Composable
private fun OpensProof(sentence: String, link: String, onOpen: () -> Unit) {
    val at = sentence.indexOf(link)
    val words = buildAnnotatedString {
        if (at < 0) {
            append(sentence)
        } else {
            append(sentence.substring(0, at))
            withStyle(SpanStyle(color = Colours.you, fontWeight = Type.weightHeading, textDecoration = TextDecoration.Underline)) { append(link) }
            append(sentence.substring(at + link.length))
        }
    }
    BasicText(
        words,
        Modifier.clickable(role = Role.Button, onClick = onOpen).defaultMinSize(minHeight = Type.minTarget).padding(vertical = 8.dp).testTag("open-proof"),
        style = TextStyle(color = Colours.ink, fontSize = Type.sizeBody, lineHeight = Type.leadingSmall),
    )
}

/** The card's link as the screen writes it, without a scheme: what goes on the profile. */
@Composable
private fun ProofLink(link: String) =
    BasicText(link, Modifier.background(Colours.soft).padding(horizontal = 12.dp, vertical = 8.dp).testTag("proof-link"), style = TextStyle(color = Colours.ink, fontSize = 15.sp, fontFamily = Type.mono))

/** What the proof log recorded, as the server says it: shown only where that is not what step 5 said. */
@Composable
private fun Recorded(c: Copy, d: CardProof.Done, view: Messages.DoneView) {
    if (!view.showRecord) return
    Stress(c.say("done.recorded"), Modifier.padding(top = 20.dp))
    Body(d.date)
    view.record?.let { Body(it) }
    Summary {
        for (row in view.rows) {
            SummaryRow(
                rowName(row.platform, row.known),
                { SummaryValue(rowAccount(row.platform, row.known, row.username), strong = true) },
                listOfNotNull(row.kind, row.expected, row.switchUsed),
                "recorded-${row.platform}",
            )
        }
    }
    if (view.record != null) Body(c.say("done.short_id", "short_id" to d.shortId))
}

/**
 * Step 6: hang the link on the profile, and nothing else (design/copy/card-proof.md, "6. 掛上去", app). Someone back for a card proof
 * again is asked only whether the link is still there, until "重新掛上連結", and the whole step then has 上一步 back to the short
 * one. No way back to step 5: it has submitted.
 */
@Composable
private fun Hang(m: Model, outside: Outside) {
    val c = m.copy
    val d = m.done ?: return
    val url = m.proofUrl(d.shortId)
    val link = "${m.domain}/p/${d.shortId}"
    val view = m.messages.done(d, m.single)
    val openProof = c.say("done.open_proof")
    val wide = Modifier.fillMaxWidth()

    // What the proof log recorded is not what step 5 said: first of all, above the date.
    view.mismatch?.let { Problem(it, Modifier.testTag("done-mismatch")) }
    Small(view.recordedOn, colour = Colours.text)
    view.kindsUnreadable?.let { Body(it) }

    val stillThere = view.stillThere
    if (stillThere != null && !m.hangWhole) {
        Title(stillThere)
        ProofLink(link)
        OpensProof(view.look, openProof) { outside.open(url) }
        Body(view.why)
        // The way on on the right, the way to the whole step on the left (Actions).
        Actions {
            Button(c.say("common.next"), wide, primary = true) { m.toRemind() }
            Button(c.say("hang.rehang"), wide) { m.hangAgain() }
        }
        return
    }

    val account = d.accounts.firstOrNull { (platform, _) -> Platforms.of(platform) != null }?.let { Platforms.handle(it.first, it.second) }
    HangWhole(m, outside, view.hangTitle, view.why, view.profiles, view.steps, view.hung, account, view.notes, d.shortId)
    Recorded(c, d, view)
    Actions {
        Button(c.say("common.next"), wide) { m.toRemind() }
        // Reached from the short one by "重新掛上連結": back to it (design/copy/card-proof.md, step 6, "回來更新的人：短版").
        if (stillThere != null) Button(c.say("common.back"), wide) { m.hangShort() }
    }
}

/**
 * The whole of step 6 under its date (design/copy/card-proof.md, "6. 掛上去", app): the link, 複製證明連結 and the profile's button,
 * the demonstration and its four steps, the notes, and how to look. `account`: the account the demonstration draws.
 */
@Composable
private fun HangWhole(m: Model, outside: Outside, title: String, why: String, profiles: List<Messages.OpensProfile>, steps: List<String>, hung: String, account: String?, notes: List<String>, shortId: String) {
    val c = m.copy
    val url = m.proofUrl(shortId)
    val link = "${m.domain}/p/$shortId"
    val openProof = c.say("done.open_proof")
    val wide = Modifier.fillMaxWidth()
    var copied by remember { mutableStateOf(false) }
    Title(title)
    Body(why)
    ProofLink(link)
    // One main button a screen (design/DESIGN.md): copying the link is what this step is for. The two side by side, above the
    // demonstration, as its first screen draws them; one over the other where they do not fit so (card-proof.md, "示範").
    val profile = profiles.firstOrNull()
    SideBySide(Modifier.fillMaxWidth().padding(top = 20.dp)) {
        Button(if (copied) c.say("done.copied") else c.say("hang.copy"), primary = true) {
            outside.copy(url)
            copied = true
        }
        if (profile != null) Button(profile.label, told = profile.told) { outside.open(profile.address) }
    }
    for (other in profiles.drop(1)) Button(other.label, wide.padding(top = 12.dp), told = other.told) { outside.open(other.address) }
    // The demonstration, with the account and the link of this card proof; then its four steps in words, the one it is showing marked.
    val demo = m.hangDemo
    if (demo != null && profile != null) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val words = HangDemoWords(title, account ?: "", link, url, profile.label)
            DemoFrame(demo, c, "hang-demo-button") { HangDemo(demo, c, words, c.say("app_demo.hang"), it) }
        }
    }
    val shown = demo?.step ?: 0
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Rule(colour = Colours.ink)
        for ((n, step) in steps.withIndex()) {
            // The step the demonstration is at: on the light grey, a bar of the red of what you do at its left (hang.md, "示範").
            val now = demo != null && demo.playing && shown == n + 1
            Row(
                Modifier.fillMaxWidth().drawBehind {
                    if (!now) return@drawBehind
                    drawRect(Colours.soft)
                    drawRect(Colours.you, size = Size(3.dp.toPx(), size.height))
                }.padding(vertical = 18.dp).padding(start = 12.dp),
            ) {
                BasicText("${n + 1}", Modifier.width(36.dp).alignByBaseline(), style = TextStyle(color = Colours.ink, fontSize = 22.sp, lineHeight = 1.4.em, fontWeight = Type.weightHeading, fontFamily = Type.display))
                BasicText(step, Modifier.weight(1f).alignByBaseline(), style = TextStyle(color = Colours.ink, fontSize = 17.sp, lineHeight = 1.6.em, fontWeight = Type.weightHeading))
            }
            Rule()
        }
    }
    for (note in notes) Small(note)
    Rule(Modifier.padding(top = 12.dp))
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        OpensProof(hung, openProof) { outside.open(url) }
        Small(c.say("done.hung_done"), colour = Colours.text)
    }
}

/**
 * Step 8: done, and the invitation to share (design/copy/card-proof.md, "8. 完成和分享", app). A card proof that withdrew everything
 * comes here from step 5: its date, that the link can be taken down, and no way back.
 */
@Composable
private fun Finish(m: Model, outside: Outside) {
    val c = m.copy
    val d = m.done ?: return
    val view = m.messages.done(d, m.single)
    val wide = Modifier.fillMaxWidth()
    if (view.withdrawAll) {
        view.mismatch?.let { Problem(it, Modifier.testTag("done-mismatch")) }
        Title(view.title)
        Body(view.recordedOn)
        view.kindsUnreadable?.let { Body(it) }
        Body(view.unlink)
        Recorded(c, d, view)
        Actions { Button(c.say("finish.done"), wide, primary = true) { m.cancel() } }
        return
    }
    val url = m.proofUrl(d.shortId)
    Title(view.title)
    SmallCard(c, view.card, d.shortId, wide.padding(top = 8.dp))
    // The card's ordinal, where the answer had one, and the invitation: one paragraph. Sharing is asked for, not required.
    Body((view.ordinal ?: "") + c.say("finish.invite"), Modifier.padding(top = 8.dp))
    Body(c.say("finish.thanks"))
    Actions {
        // One main button a screen (design/DESIGN.md): the first platform's, were there more than one.
        for ((n, share) in view.shares.withIndex()) Button(share, wide, primary = n == 0) { outside.share("${view.shareText}\n$url") }
        Button(c.say("finish.done"), wide) { m.cancel() }
        Button(c.say("common.back"), wide) { m.backFromDone() }
    }
}

/** The panel of a tap, from the bottom of the screen (design/copy/card-proof.md, "app：感應的面板"). */
@Composable
private fun TapPanel(m: Model, tap: CardProof.Tap) {
    val c = m.copy
    // What is under the panel takes no press while it is up.
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}, contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier.fillMaxWidth().background(Colours.bg, RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)).padding(horizontal = Type.gutter, vertical = 24.dp).testTag("tap-panel"),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            val cancel = @Composable { Actions { Button(c.say("common.cancel"), Modifier.fillMaxWidth()) { m.cancelTap() } } }
            when (tap) {
                CardProof.Tap.WAITING -> {
                    Stress(c.say("app_panel.android_wait_title"))
                    Body(c.say("app_panel.android_wait"))
                    cancel()
                }
                CardProof.Tap.READING -> {
                    Stress(c.say("app_panel.android_busy_title"))
                    Body(c.say("app_panel.reading"))
                    cancel()
                }
                CardProof.Tap.SIGNING -> {
                    Stress(c.say("app_panel.android_busy_title"))
                    Body(c.say("app_panel.signing"))
                    cancel()
                }
                CardProof.Tap.READ -> {
                    Stress(c.say("app_panel.android_done_title"))
                    Body(c.say("app_panel.read"))
                }
                CardProof.Tap.SIGNED -> {
                    Stress(c.say("app_panel.android_done_title"))
                    Body(c.say("app_panel.signed"))
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** The seconds step 5 says the proof takes on Android (design/copy/card-proof.md, "5. 確認", app). */
private const val COMPUTE_SECONDS = 10
