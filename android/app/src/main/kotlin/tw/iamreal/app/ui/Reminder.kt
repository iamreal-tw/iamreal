package tw.iamreal.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import tw.iamreal.app.reminder.Interval
import tw.iamreal.app.reminder.Plan
import tw.iamreal.app.reminder.Reminders
import tw.iamreal.app.reminder.When
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

/** The app's screens: the card proof, the settings, the reminder's interval and time. */
internal enum class Screen { CARD_PROOF, SETTINGS, SCHEDULE }

/** The system's pickers of a day and of a time, from the activity. */
internal class Pickers(
    val day: (initial: LocalDate, range: ClosedRange<LocalDate>, picked: (LocalDate) -> Unit) -> Unit,
    val time: (initial: LocalTime, picked: (LocalTime) -> Unit) -> Unit,
)

/**
 * The reminder as the screens show it (design/copy/app.md, "過卡提醒", "設定"; card-proof.md, "6. 完成",
 * app), and which screen is up. What is stored is [Reminders]'s; what is here besides is in memory only.
 */
internal class ReminderModel(
    private val reminders: Reminders,
    /** design/copy/app.json. */
    val app: Copy,
    private val today: () -> LocalDate,
    private val now: () -> LocalDateTime,
) {
    val words = When(app)

    /**
     * Asks the system to let the app notify (Android 13 on), then says whether it may: set by the activity
     * that is up. Until then, nothing is allowed.
     */
    var askPermission: ((Boolean) -> Unit) -> Unit = { it(false) }

    var screen by mutableStateOf(Screen.CARD_PROOF)
        private set
    private var scheduleFrom = Screen.CARD_PROOF

    var plan by mutableStateOf(reminders.plan)
        private set

    /** The plan's day was picked, not worked out by its interval: until the next card proof. */
    var picked by mutableStateOf(false)
        private set

    /** Step 6: "開啟提醒" was pressed and the system did not let the app notify. */
    var doneDenied by mutableStateOf(false)
        private set

    /** The app was opened from the notification and no card proof has been completed since. */
    var fromNotification by mutableStateOf(false)
        private set

    /** After "一週後再提醒我" on step 1: the reminder it set. */
    var snoozed by mutableStateOf<Plan?>(null)
        private set

    // The screen of the interval and the time.
    var draftInterval by mutableStateOf(Reminders.DEFAULT_INTERVAL)
        private set
    var draftTime by mutableStateOf(Reminders.DEFAULT_TIME)
        private set
    var draftPicked by mutableStateOf<LocalDate?>(null)
        private set
    var scheduleDenied by mutableStateOf(false)
        private set

    fun today(): LocalDate = today.invoke()

    /** The day the screen of the interval and the time would set. */
    val draftDay: LocalDate get() = draftPicked ?: Reminders.next(today(), draftInterval)

    /** The reminder that is on has come already: nothing until the next card proof. */
    val passed: Boolean get() = plan != null && reminders.passed(now())

    /** What is stored may have changed outside the screens: "一週後再提醒我" on the notification. */
    fun refresh() {
        plan = reminders.plan
    }

    /** A card proof was completed: a reminder that is on comes again from today. */
    fun cardProofDone() {
        plan = reminders.afterCardProof(today())
        picked = false
        doneDenied = false
        fromNotification = false
        snoozed = null
    }

    /** The app was opened from the notification. */
    fun openedFromNotification() {
        fromNotification = true
        snoozed = null
        screen = Screen.CARD_PROOF
        refresh()
    }

    /** "開啟提醒" on step 6: the defaults, once the system lets the app notify. */
    fun turnOnFromDone() = askPermission { allowed ->
        if (allowed) {
            plan = reminders.turnOn(Reminders.DEFAULT_INTERVAL, Reminders.DEFAULT_TIME, null, today())
            picked = false
        } else {
            doneDenied = true
        }
    }

    /** "改間隔或時刻", "更改", the switch turned on: the screen of the interval and the time, from what is on, else the defaults. */
    fun openSchedule() {
        scheduleFrom = screen
        draftInterval = plan?.interval ?: Reminders.DEFAULT_INTERVAL
        draftTime = plan?.time ?: Reminders.DEFAULT_TIME
        draftPicked = null
        scheduleDenied = false
        screen = Screen.SCHEDULE
    }

    fun chooseInterval(interval: Interval) {
        draftInterval = interval
        draftPicked = null
    }

    fun chooseDay(day: LocalDate) {
        draftPicked = day
    }

    fun chooseTime(time: LocalTime) {
        draftTime = time
    }

    /** "開啟提醒" or "儲存" of the screen of the interval and the time. */
    fun saveSchedule() {
        val save = {
            plan = reminders.turnOn(draftInterval, draftTime, draftPicked?.takeIf { it in Reminders.pickable(today()) }, today())
            picked = draftPicked != null
            doneDenied = false
            screen = scheduleFrom
        }
        if (plan != null) return save()
        askPermission { allowed -> if (allowed) save() else scheduleDenied = true }
    }

    fun closeSchedule() {
        screen = scheduleFrom
    }

    fun openSettings() {
        screen = Screen.SETTINGS
    }

    fun closeSettings() {
        screen = Screen.CARD_PROOF
    }

    /** The switch of the settings turned off: nothing of the reminder is left on the phone. */
    fun turnOff() {
        reminders.turnOff()
        plan = null
        picked = false
    }

    /** "一週後再提醒我" on step 1. */
    fun snooze() {
        snoozed = reminders.snooze(today())
        plan = reminders.plan
    }

    /** The system's back: true if it closed one of the reminder's screens. */
    fun back(): Boolean = when (screen) {
        Screen.CARD_PROOF -> false
        Screen.SETTINGS -> true.also { closeSettings() }
        Screen.SCHEDULE -> true.also { closeSchedule() }
    }

    /** `2027-02-08（星期一）晚上 9:00`. */
    fun at(day: LocalDate, time: LocalTime): String = words.day(day) + words.time(time)
}

/** What step 6 says of the reminder: its heading, its sentence, the line under it, and the certificate's sentence. */
internal class DoneReminder(val kind: Kind, val title: String, val text: String, val local: String, val expires: String?, val at: String?) {
    enum class Kind { ASK, ON, DENIED }
}

/**
 * What step 6 says of the reminder (design/copy/card-proof.md, "6. 完成", app, "提醒"): offered when
 * nothing is stored, the day it was set again for when it is on, the web's two sentences and why when
 * the system did not let the app notify. [validUntil] is the certificate's last day, from memory.
 */
internal fun doneReminder(card: Copy, words: When, plan: Plan?, picked: Boolean, denied: Boolean, validUntil: String?, today: LocalDate): DoneReminder {
    if (plan == null && denied) return DoneReminder(DoneReminder.Kind.DENIED, card.say("done.return_title"), card.say("done.return_note"), card.say("app_done.reminder_denied"), null, null)
    val shown = plan ?: Plan(Reminders.DEFAULT_INTERVAL, Reminders.DEFAULT_TIME, Reminders.next(today, Reminders.DEFAULT_INTERVAL))
    val day = words.day(shown.day)
    val time = words.time(shown.time)
    val next = if (plan != null && picked) {
        card.say("app_done.reminder_next", "day" to day, "time" to time)
    } else {
        card.say("app_done.reminder_next_about", "day" to day, "time" to time, "interval" to words.interval(shown.interval))
    }
    val until = validUntil?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
    val expires = if (until != null && until.isBefore(shown.day)) card.say("app_done.reminder_expires", "valid_until" to validUntil) else null
    return DoneReminder(
        if (plan == null) DoneReminder.Kind.ASK else DoneReminder.Kind.ON,
        card.say("app_done.reminder_title"),
        card.say("app_done.reminder_why") + next,
        card.say("app_done.reminder_local"),
        expires,
        day + time,
    )
}

/** A sentence with the day and time of the reminder in it set in bold. */
@Composable
private fun WithDay(text: String, at: String?, modifier: Modifier = Modifier) {
    val i = if (at == null) -1 else text.indexOf(at)
    val shown = buildAnnotatedString {
        if (i < 0) {
            append(text)
        } else {
            append(text.substring(0, i))
            withStyle(SpanStyle(color = Colours.ink, fontWeight = Type.weightHeading)) { append(at!!) }
            append(text.substring(i + at!!.length))
        }
    }
    BasicText(shown, modifier.padding(top = 6.dp), style = TextStyle(color = Colours.text, fontSize = 15.sp, lineHeight = 1.75.em))
}

/** The last of what can be done besides on step 6: the reminder (design/screens/app-reminder-1-done-phone.png). */
@Composable
internal fun DoneReminderSection(r: ReminderModel, card: Copy, validUntil: String?) {
    val say = doneReminder(card, r.words, r.plan, r.picked, r.doneDenied, validUntil, r.today())
    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp).testTag("done-reminder")) {
        Subhead(say.title)
        WithDay(say.text, say.at)
        BasicText(say.local, Modifier.padding(top = 6.dp), style = TextStyle(color = Colours.text, fontSize = 15.sp, lineHeight = 1.75.em))
        say.expires?.let { BasicText(it, Modifier.padding(top = 6.dp), style = TextStyle(color = Colours.ink, fontSize = 15.sp, lineHeight = 1.75.em)) }
        when (say.kind) {
            DoneReminder.Kind.ASK -> {
                Button(card.say("app_done.reminder_turn_on"), Modifier.fillMaxWidth().padding(top = 12.dp), primary = true, height = 46.dp) { r.turnOnFromDone() }
                SmallLink(card.say("app_done.reminder_adjust")) { r.openSchedule() }
            }
            DoneReminder.Kind.ON -> SmallLink(card.say("app_done.reminder_change")) { r.openSchedule() }
            DoneReminder.Kind.DENIED -> {}
        }
    }
}

/** A link that changes something in the app: the red of what you do, underlined, the size of the notes. */
@Composable
private fun SmallLink(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) = BasicText(
    text,
    modifier.clickable(role = Role.Button, onClick = onClick).defaultMinSize(minHeight = Type.minTarget).padding(vertical = 10.dp),
    style = TextStyle(color = Colours.you, fontSize = 15.sp, textDecoration = TextDecoration.Underline),
)

/** Above step 1, opened from the notification (design/screens/app-reminder-4-from-notification-phone.png). */
@Composable
internal fun FromReminder(r: ReminderModel) {
    if (!r.fromNotification) return
    val snoozed = r.snoozed
    if (snoozed == null && r.plan == null) return
    Column(
        Modifier.fillMaxWidth().background(Colours.soft, RoundedCornerShape(Type.radiusPanel)).padding(16.dp).testTag("from-reminder"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (snoozed != null) {
            BasicText(r.app.say("from_notification.snoozed", "day" to r.words.day(snoozed.day), "time" to r.words.time(snoozed.time)), style = TextStyle(color = Colours.ink, fontSize = 15.sp, lineHeight = 1.75.em))
        } else {
            BasicText(r.app.say("from_notification.note"), style = TextStyle(color = Colours.ink, fontSize = 15.sp, lineHeight = 1.75.em))
            Button(r.app.say("notification.snooze"), Modifier.fillMaxWidth(), height = 44.dp) { r.snooze() }
        }
    }
}

/** A screen of the app besides the card proof: the bar at the top, the screen under it, scrolled. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun Page(tag: String, bar: @Composable () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(Colours.bg).safeDrawingPadding().semantics { testTagsAsResourceId = true }) {
        Column(Modifier.fillMaxSize()) {
            bar()
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Type.gutter).padding(top = 28.dp, bottom = 48.dp).testTag(tag),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) { content() }
        }
    }
}

/** A small label over a group of rows. */
@Composable
private fun Label(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier.padding(top = 14.dp), style = TextStyle(color = Colours.mute, fontSize = 14.sp))

/** A row between lines: what it is on the left, its value and what can be done on the right. */
@Composable
private fun SettingRow(label: String, modifier: Modifier = Modifier, right: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 54.dp).then(modifier).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        BasicText(label, Modifier.weight(1f), style = TextStyle(color = Colours.ink, fontSize = Type.sizeBody, lineHeight = 1.5.em))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) { right() }
    }
    Rule()
}

@Composable
private fun Value(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier, style = TextStyle(color = Colours.text, fontSize = 15.sp))

/** "更改" at the end of a row. */
@Composable
private fun Change(text: String, tag: String, onClick: () -> Unit) = BasicText(
    text,
    Modifier.clickable(role = Role.Button, onClick = onClick).defaultMinSize(minHeight = Type.minTarget).padding(vertical = 10.dp).testTag(tag),
    style = TextStyle(color = Colours.you, fontSize = 15.sp, textDecoration = TextDecoration.Underline),
)

/** A choice of one of several: a ring, filled in ink when it is the one. */
@Composable
private fun Radio(selected: Boolean) = Box(
    Modifier.size(20.dp).border(1.5.dp, if (selected) Colours.ink else Colours.mute, CircleShape).padding(5.dp),
) { if (selected) Box(Modifier.fillMaxSize().background(Colours.ink, CircleShape)) }

/** An arrow of a row: to the right (goes somewhere), or to the left (back). */
@Composable
private fun Arrow(left: Boolean = false) = Canvas(Modifier.size(width = 8.dp, height = 12.dp)) {
    val w = size.width
    val h = size.height
    val tip = if (left) 0f else w
    val tail = if (left) w else 0f
    val stroke = 1.5.dp.toPx()
    drawLine(Colours.ink, Offset(tail, 0f), Offset(tip, h / 2), stroke, cap = StrokeCap.Round)
    drawLine(Colours.ink, Offset(tip, h / 2), Offset(tail, h), stroke, cap = StrokeCap.Round)
}

/** A switch: on is filled in ink. */
@Composable
private fun Switch(on: Boolean, tag: String, onChange: (Boolean) -> Unit) = Box(
    Modifier.size(width = 50.dp, height = 30.dp)
        .background(if (on) Colours.ink else Colours.line, RoundedCornerShape(15.dp))
        .clickable(role = Role.Switch) { onChange(!on) }
        .padding(3.dp)
        .testTag(tag),
    contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
) { Box(Modifier.size(24.dp).background(Colours.bg, CircleShape)) }

/** The interval and the time of the reminder (design/copy/app.md, "選間隔和時刻"; design/screens/app-reminder-2-schedule-phone.png). */
@Composable
internal fun ScheduleScreen(r: ReminderModel, pickers: Pickers, serviceName: String) {
    val a = r.app
    Page("schedule", { Header(serviceName) }) {
        Title(a.say("reminder.title"))
        Body(a.say("reminder.from_today"))
        Column(Modifier.fillMaxWidth()) {
            Label(a.say("reminder.how_often"), Modifier.padding(bottom = 8.dp))
            Rule()
            val choices = listOf(Interval.WEEKS_4 to "reminder.weeks_4", Interval.WEEKS_12 to "reminder.weeks_12", Interval.WEEKS_26 to "reminder.weeks_26")
            for ((interval, key) in choices) {
                val selected = r.draftPicked == null && r.draftInterval == interval
                Row(
                    Modifier.fillMaxWidth().clickable(role = Role.RadioButton) { r.chooseInterval(interval) }.defaultMinSize(minHeight = 54.dp).padding(vertical = 8.dp).testTag("interval-${interval.weeks}"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Radio(selected)
                    BasicText(a.say(key), Modifier.weight(1f), style = TextStyle(color = Colours.ink, fontSize = Type.sizeBody))
                    if (interval == Reminders.DEFAULT_INTERVAL) BasicText(a.say("reminder.suggested"), style = TextStyle(color = Colours.mute, fontSize = 13.sp))
                }
                Rule()
            }
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.RadioButton) {
                    val range = Reminders.pickable(r.today())
                    pickers.day(r.draftPicked ?: r.draftDay, range) { r.chooseDay(it) }
                }.defaultMinSize(minHeight = 54.dp).padding(vertical = 8.dp).testTag("pick-date"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Radio(r.draftPicked != null)
                BasicText(a.say("reminder.pick_date"), Modifier.weight(1f), style = TextStyle(color = Colours.ink, fontSize = Type.sizeBody))
            }
            Rule()
        }
        Column(Modifier.fillMaxWidth()) {
            Label(a.say("reminder.when"), Modifier.padding(bottom = 8.dp))
            Rule()
            SettingRow(a.say("reminder.time")) {
                Value(r.words.time(r.draftTime))
                Change(a.say("reminder.change"), "change-time") { pickers.time(r.draftTime) { r.chooseTime(it) } }
            }
        }
        val at = r.at(r.draftDay, r.draftTime)
        Column(Modifier.padding(top = 8.dp)) {
            val next = a.say("reminder.next", "day" to r.words.day(r.draftDay), "time" to r.words.time(r.draftTime))
            val i = next.indexOf(at)
            BasicText(
                buildAnnotatedString {
                    append(next.substring(0, i.coerceAtLeast(0)))
                    withStyle(SpanStyle(fontWeight = Type.weightHeading)) { append(if (i < 0) next else at) }
                },
                Modifier.testTag("next-reminder"),
                style = TextStyle(color = Colours.ink, fontSize = 18.sp, lineHeight = 1.6.em),
            )
            Small(a.say("reminder.evening"), Modifier.padding(top = 6.dp))
        }
        if (r.scheduleDenied) Problem(a.say("reminder.denied"))
        Actions {
            Button(if (r.plan == null) a.say("reminder.turn_on") else a.say("reminder.save"), Modifier.fillMaxWidth(), primary = true) { r.saveSchedule() }
            Button(a.say("reminder.cancel"), Modifier.fillMaxWidth()) { r.closeSchedule() }
        }
    }
}

/** The settings (design/copy/app.md, "設定"; design/screens/app-settings-phone.png). The links open the site in the browser. */
@Composable
internal fun SettingsScreen(r: ReminderModel, outside: Outside, version: String, site: String) {
    val a = r.app
    Page("settings", {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.height(56.dp).clickable(role = Role.Button) { r.closeSettings() }.padding(horizontal = Type.gutter),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Arrow(left = true)
                BasicText(a.say("settings.back"), style = TextStyle(color = Colours.ink, fontSize = 16.sp))
            }
            Rule()
        }
    }) {
        Title(a.say("settings.title"))
        Column(Modifier.fillMaxWidth()) {
            Label(a.say("settings.reminder"), Modifier.padding(bottom = 8.dp))
            Rule()
            val plan = r.plan
            SettingRow(a.say("settings.switch")) { Switch(plan != null, "reminder-switch") { on -> if (on) r.openSchedule() else r.turnOff() } }
            if (plan != null) {
                SettingRow(a.say("settings.interval")) {
                    Value(r.words.interval(plan.interval))
                    Change(a.say("reminder.change"), "change-interval") { r.openSchedule() }
                }
                SettingRow(a.say("settings.time")) {
                    Value(r.words.time(plan.time))
                    Change(a.say("reminder.change"), "change-time") { r.openSchedule() }
                }
                SettingRow(a.say("settings.next")) { Value(if (r.passed) a.say("settings.next_none") else r.words.day(plan.day), Modifier.testTag("settings-next")) }
            }
            Small(a.say("settings.stored"), Modifier.padding(top = 14.dp), colour = Colours.text)
        }
        Column(Modifier.fillMaxWidth()) {
            Label(a.say("settings.about"), Modifier.padding(bottom = 8.dp))
            Rule()
            SettingRow(a.say("settings.version")) { Value(version, Modifier.testTag("version")) }
            SettingRow(a.say("settings.faq"), Modifier.clickable(role = Role.Button) { outside.open("$site/faq") }) { Arrow() }
            SettingRow(a.say("settings.privacy"), Modifier.clickable(role = Role.Button) { outside.open("$site/privacy") }) { Arrow() }
            SettingRow(a.say("settings.source"), Modifier.clickable(role = Role.Button) { outside.open(SOURCE) }) { Arrow() }
        }
        Spacer(Modifier.height(8.dp))
    }
}

/** Where the app's code is: this repository. */
private const val SOURCE = "https://github.com/iamreal-tw/iamreal"
