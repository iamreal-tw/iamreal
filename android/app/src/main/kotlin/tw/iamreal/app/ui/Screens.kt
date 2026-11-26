package tw.iamreal.app.ui

import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.flow.Platforms

/**
 * What a screen asks of the phone: an address opened outside the app (false when no app on the phone opens it), a text put on the clipboard,
 * a text handed to the system's share sheet.
 */
internal class Outside(val open: (String) -> Boolean, val copy: (String) -> Unit, val share: (String) -> Unit, val nfcSettings: () -> Unit)

/**
 * The six steps (design/copy/card-proof.md), one screen each, laid out
 * after design/screens/card-proof-app-*, and the panel of a tap over them.
 * Every sentence is the copy's; which one is [Messages]'s and [Model]'s to
 * say. No screen links to a page of the site but step 6, whose links are the
 * card's own pages and the platform's; step 1's two links are for someone
 * without a card yet, who gets no further (docs/design/principles.md, 1).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun CardProofScreens(m: Model, r: ReminderModel, outside: Outside) {
    // The tags below are the names a test finds the fields by.
    Box(Modifier.fillMaxSize().background(Colours.bg).safeDrawingPadding().imePadding().semantics { testTagsAsResourceId = true }) {
        Column(Modifier.fillMaxSize()) {
            // The settings from the first and the last step: not while a card proof is under way.
            val settings = m.step == Step.BEFORE || m.step == Step.DONE
            Header(m.copy.say("common.service_name"), if (settings) r.app.say("settings.open") else null) { r.openSettings() }
            // Each step starts at its top.
            key(m.step) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Type.gutter).padding(top = 28.dp, bottom = 48.dp).testTag("step-${m.step.name.lowercase()}"),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    // Opened from the reminder's notification: above everything of step 1 (design/screens/app-reminder-4-from-notification-phone.png).
                    // The minimum version's sentence, when the app has it (issue #171), goes above it.
                    if (m.step == Step.BEFORE) FromReminder(r)
                    StepBar(m.copy, m.step.number)
                    Spacer(Modifier.height(6.dp))
                    when (m.step) {
                        Step.BEFORE -> Before(m, outside)
                        Step.READ -> Read(m, outside)
                        Step.PIN -> Pin(m)
                        Step.ACCOUNTS -> Accounts(m, outside)
                        Step.CONFIRM -> Confirm(m)
                        Step.PROGRESS -> Progress(m)
                        Step.DONE -> Done(m, r, outside)
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

/** before.how_to_get_moica: the certificate authority's site (design/copy/card-proof.md, "1. 開始之前"). */
private const val MOICA = "https://moica.nat.gov.tw/"

@Composable
private fun Before(m: Model, outside: Outside) {
    val c = m.copy
    m.notice?.let { Problem(it) }
    Title(c.say("before.title"))
    Body(c.say("before.prepare_card"), strong = true)
    Body(c.say("before.citizens_only"))
    // With one platform nothing more: what the proof says, and that it is public, is step 5's to say.
    for (line in m.messages.beforeSeveral()) Body(line)
    Actions { Button(c.say("common.next"), Modifier.fillMaxWidth(), primary = true) { m.start() } }
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
        Body(c.say("app_read.how", "spot" to c.say("app_read.spot_android")))
        TapPlace(c)
    }
    TaskList(c, listOf(c.say("read.server"), c.say("app_read.certificate"), c.say("read.check"), c.say("read.crl")), m.readItems, m.readMessage, "read-list")
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
}

@Composable
private fun Pin(m: Model) {
    val c = m.copy
    val busy = m.pinBusy != null
    Title(c.say("pin.title"))
    // What was read from the card, shown only here: a box of its own.
    Column(Modifier.fillMaxWidth().padding(top = 8.dp).background(Colours.soft, RoundedCornerShape(Type.radiusPanel)).padding(horizontal = 20.dp, vertical = 18.dp)) {
        Small(c.say("pin.card_read"))
        BasicText(m.name, Modifier.testTag("card-name"), style = TextStyle(color = Colours.ink, fontSize = Type.sizeH3, lineHeight = Type.leadingH3, fontWeight = Type.weightHeading, fontFamily = Type.display))
        Small(c.say("pin.name_note"))
    }
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Subhead(c.say("pin.label"))
        PinInput(m.pin, enabled = !busy && !m.pinEnded, tag = "pin", modifier = Modifier.fillMaxWidth())
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
            is Messages.DeclaredView -> DeclaredAccounts(m, view)
        }
    }
}

/** 3 records of the card today: the sentence, and "回到開頭", which drops the PIN as "取消" does. */
@Composable
private fun DailyLimit(m: Model, sentence: String) {
    Body(sentence, strong = true)
    Actions { Button(m.copy.say("accounts.restart"), Modifier.fillMaxWidth(), primary = true) { m.cancel() } }
}

/** The card declares accounts: what it declares and when it last did, "更新島民證明", and the other things to do. */
@Composable
private fun DeclaredAccounts(m: Model, view: Messages.DeclaredView) {
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
    view.dailyLimit?.let { return DailyLimit(m, it) }
    m.listMessage?.let { Problem(it) }
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
                m.fields[row.platform] = it
            }
            if (row.preview) Button(m.copy.say("app_accounts.preview"), height = 52.dp) { m.previewUrl(row.platform)?.let(outside.open) }
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
    view.dailyLimit?.let { return DailyLimit(m, it) }
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
        ProgressButton.RESTART -> Actions { Button(c.say("accounts.restart"), Modifier.fillMaxWidth(), primary = true) { m.cancel() } }
    }
}

/** A line across in dashes: between the things that can be done besides (design/DESIGN.md, "線"). */
@Composable
private fun DashedRule() = Canvas(Modifier.fillMaxWidth().height(1.dp)) {
    drawLine(Colours.dot, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())))
}

/** The card's proof in small (design/DESIGN.md, "證明卡"): the mark, its accounts, how its short ID begins. No red: it is not the card. */
@Composable
private fun SmallCard(c: Copy, accounts: List<Pair<String?, String>>, shortId: String, modifier: Modifier = Modifier) = Column(
    modifier.background(Colours.bg, RoundedCornerShape(Type.radiusPanel)).border(1.5.dp, Colours.ink, RoundedCornerShape(Type.radiusPanel)).padding(10.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Logo(Modifier.size(18.dp), animated = true)
        BasicText(c.say("done.proof"), style = TextStyle(color = Colours.ink, fontSize = 12.sp, fontWeight = Type.weightHeading))
    }
    Spacer(Modifier.height(4.dp))
    for ((name, account) in accounts) {
        if (name != null) BasicText(name, style = TextStyle(color = Colours.mute, fontSize = 11.sp))
        BasicText(account, Modifier.testTag("proof-account"), style = TextStyle(color = Colours.ink, fontSize = Type.sizeBody, lineHeight = 1.2.em, fontWeight = Type.weightAccount))
    }
    ShortId(c.say("confirm.short_id_label") + " " + c.say("confirm.short_id", "short_id" to shortId), shortId, size = 10.sp, colour = Colours.text)
}

@Composable
private fun Done(m: Model, r: ReminderModel, outside: Outside) {
    val c = m.copy
    val d = m.done ?: return
    val url = m.proofUrl(d.shortId)
    val link = "${m.domain}/p/${d.shortId}"
    var copied by remember { mutableStateOf(false) }
    val view = m.messages.done(d, m.single)

    // What the proof log recorded is not what step 5 said: first of all, above the title.
    view.mismatch?.let { Problem(it, Modifier.testTag("done-mismatch")) }
    if (view.withdrawAll) {
        Title(view.title)
        Body(view.recordedOn)
    } else {
        Row(
            Modifier.fillMaxWidth().background(Colours.soft, RoundedCornerShape(Type.radiusPanel)).padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SmallCard(c, view.card, d.shortId, Modifier.width(120.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Stress(view.title)
                Small(view.recordedOn, colour = Colours.text)
            }
        }
    }
    view.kindsUnreadable?.let { Body(it) }

    // The body: hang the link on the profile (design/copy/hang.md, part 1), without the web's QR code.
    val notes = listOfNotNull(
        if (view.newCard && !view.withdrawAll) c.say("done.new_card") else null,
        if (view.withdrawnLink) c.say("done.withdrawn_link") else null,
    ) + view.otherCards
    if (!view.withdrawAll) {
        Title(view.hangTitle, Modifier.padding(top = 26.dp))
        BasicText(view.anyone, style = TextStyle(color = Colours.ink, fontSize = 17.sp, lineHeight = 1.8.em))
        BasicText(link, Modifier.padding(top = 6.dp).background(Colours.soft).padding(horizontal = 12.dp, vertical = 8.dp).testTag("proof-link"), style = TextStyle(color = Colours.ink, fontSize = 15.sp, fontFamily = Type.mono))
        Button(if (copied) c.say("done.copied") else c.say("done.copy"), Modifier.fillMaxWidth(), primary = true) {
            outside.copy(url)
            copied = true
        }
        for ((sentence, address) in view.profiles) Link(sentence) { outside.open(address) }
        Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Rule(colour = Colours.ink)
            for ((n, step) in listOf(c.say("done.step_edit"), c.say("done.step_link"), c.say("done.step_add"), c.say("done.step_paste")).withIndex()) {
                Row(Modifier.fillMaxWidth().padding(vertical = 18.dp)) {
                    BasicText("${n + 1}", Modifier.width(36.dp).alignByBaseline(), style = TextStyle(color = Colours.ink, fontSize = 22.sp, lineHeight = 1.4.em, fontWeight = Type.weightHeading, fontFamily = Type.display))
                    BasicText(step, Modifier.weight(1f).alignByBaseline(), style = TextStyle(color = Colours.ink, fontSize = 17.sp, lineHeight = 1.6.em, fontWeight = Type.weightHeading))
                }
                Rule()
            }
        }
        for (note in notes) Small(note)
        Rule(Modifier.padding(top = 12.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Link(view.hung) { outside.open(url) }
            Small(c.say("done.hung_done"), colour = Colours.text)
        }
    } else {
        for (note in notes) Small(note)
    }

    // What the proof log recorded: only where it is not what step 5 said.
    if (view.showRecord) {
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

    // What can be done besides, not needed for the proof.
    if (!view.withdrawAll) {
        Column(Modifier.fillMaxWidth().padding(top = 36.dp)) {
            BasicText(c.say("done.optional"), Modifier.padding(bottom = 14.dp), style = TextStyle(color = Colours.mute, fontSize = 15.sp))
            for ((note, button) in view.shares) {
                DashedRule()
                Optional(c.say("done.share_title"), note) { Button(button, Modifier.fillMaxWidth().padding(top = 12.dp), height = 46.dp) { outside.share("${view.shareText}\n$url") } }
            }
            DashedRule()
            // The reminder, in the place of the web's "記得每三個月回來過卡一次" (design/copy/card-proof.md, "6. 完成", app, "提醒").
            DoneReminderSection(r, c, d.validUntil)
        }
    }
    // Another card proof.
    Actions { Button(c.say("done.restart"), Modifier.fillMaxWidth()) { m.cancel() } }
}

/** One of the things that can be done besides: its heading, what it is, and a button where there is one. */
@Composable
private fun Optional(title: String, note: String, button: @Composable () -> Unit = {}) = Column(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
    Subhead(title)
    BasicText(note, Modifier.padding(top = 6.dp), style = TextStyle(color = Colours.text, fontSize = 15.sp, lineHeight = 1.75.em))
    button()
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
