package tw.iamreal.app.ui

import tw.iamreal.app.card.CardException
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.flow.Platforms
import tw.iamreal.app.flow.Stop

/**
 * Which sentence of the copy a screen shows (design/copy/card-proof.md,
 * the parts marked app and the shared ones): for each reason a card proof
 * stopped, for each row of the card's list, for the list to be signed and
 * for what was recorded. The same choices as web/src/ui/messages.ts, with
 * the app's sentences where the copy has them.
 *
 * Where the copy says the app's sentence is not written yet, there is none
 * here: the screen shows that it stopped (common.halted) and nothing more.
 */
internal class Messages(private val c: Copy) {
    /** Where a stop is shown: the sentences differ by the step. */
    enum class At { READ, PIN, DECLARE }

    /** The sentence for a stop, or null where the copy has none for the app. */
    fun stop(stop: Stop, at: At): String? = when (stop.code) {
        "card" -> when (stop.values["reason"]) {
            // Android's own sentences where a card is looked for on the phone's back: moving it is how it is found, and it is kept
            // still only once the screen says it is being read (design/copy/card-proof.md, the rule for Android after step 2).
            CardException.Reason.NO_TAP.name -> c.say("app_stops.no_tap_android")
            CardException.Reason.DROPPED.name -> when (at) {
                At.READ -> c.say("app_stops.read_dropped_android")
                At.PIN -> c.say("app_stops.dropped_pin_kept")
                At.DECLARE -> c.say("app_stops.dropped")
            }
            // At tap 3 the card had taken this PIN at tap 2: the PIN stays, as when the card left later.
            CardException.Reason.PIN_MAYBE_SENT.name -> if (at == At.DECLARE) c.say("app_stops.dropped") else c.say("app_stops.pin_maybe_received")
            CardException.Reason.PIN_INCORRECT.name -> c.say("pin.pin_incorrect")
            CardException.Reason.LOCKED.name -> c.say("stops.card_locked")
            // At step 2 the sentence names its button; later the tap is made again once NFC is back on.
            CardException.Reason.NFC_OFF.name -> if (at == At.READ) c.say("app_stops.nfc_off") else c.say("app_stops.nfc_off_tap")
            CardException.Reason.CHANNEL.name -> c.say("app_stops.channel")
            CardException.Reason.FIRST_GENERATION.name -> c.say("app_stops.first_generation")
            // On the panels of reading and of the PIN, cancelling says nothing.
            CardException.Reason.CANCELLED.name -> if (at == At.DECLARE) c.say("app_stops.tap_cancelled") else null
            else -> null
        }
        "other_card" -> if (at == At.DECLARE) c.say("app_stops.other_card_declare") else c.say("app_stops.other_card")
        "certificate" -> when (stop.values["problem"]) {
            "expired" -> stop.values["date"]?.let { c.say("stops.expired", "expiry_date" to it) }
            "not_yet_valid" -> stop.values["date"]?.let { c.say("stops.not_yet_valid", "valid_from" to it) }
            "not_citizen_primary" -> c.say("stops.not_citizen_primary")
            "unsupported_format" -> c.say("stops.unsupported_format")
            "unknown_issuer" -> c.say("stops.unknown_issuer")
            "no_certificate" -> c.say("app_stops.no_certificate")
            else -> null
        }
        "crl" -> when (stop.values["code"]) {
            "crl_stale" -> c.say("stops.crl_stale", "crl_days" to stop.values.getValue("days"))
            "crl_rollback" -> c.say("app_stops.crl_rollback")
            else -> c.say("stops.crl_unavailable", "code" to stop.values.getValue("code"))
        }
        "revoked" -> c.say("stops.revoked")
        "server" -> if (stop.tooMany) {
            // Too many people (429, or 503 `busy`; ADR-0026): the same request can be sent again, the card not held to the phone again.
            c.say("stops.too_many")
        } else when (val code = stop.values.getValue("code")) {
            "network" -> if (at == At.DECLARE && stop.values["submitting"] == "true") c.say("stops.submit_failed") else c.say("stops.server_unreadable", "code" to code)
            "crl_stale" -> c.say("stops.server_crl_stale")
            "daily_limit" -> c.say("stops.daily_limit")
            // The server takes no card proof for now (docs/api/card-proof.md, `paused`): not a failure to send again.
            "paused" -> c.say("stops.paused")
            "switch_restricted" -> c.say("stops.switch_restricted")
            // The app's sentences for these three are not written yet.
            "challenge_unknown", "switch_limit", "empty" -> null
            in REJECTED -> c.say("stops.rejected", "code" to code)
            else -> c.say("stops.server_unreadable", "code" to code)
        }
        "date_mismatch" -> c.say("app_stops.date_mismatch")
        "date_changed" -> c.say("stops.date_changed")
        else -> null
    }

    /** The format hint of a platform (card-proof.json, `formats`), or the general sentence. */
    fun formatHint(platform: String): String =
        Platforms.of(platform)?.formatHint?.takeIf { c.has("formats.$it") }?.let { c.say("formats.$it") } ?: c.say("accounts.format_no_hint")

    /** The one platform's name when the screens speak of one platform (card-proof.md, "只有一個平台時"); null otherwise. */
    fun onePlatform(status: CardProof.Status): String? =
        if (status.tablePlatforms.size == 1 && status.slots.all { it.known }) Platforms.of(status.tablePlatforms[0])?.name else null

    /** Step 1's sentences of a proof that lists several accounts (before.one_proof, before.listed_together): only when the app knows more than one platform. */
    fun beforeSeveral(): List<String> = if (Platforms.known.size == 1) emptyList() else listOf(c.say("before.one_proof"), c.say("before.listed_together"))

    // Step 4 ---------------------------------------------------------------------------

    /** A row of step 4 with a field, or shown as it is. */
    class AccountRow(
        val platform: String,
        /** The app's name for the platform; its ID for one the app does not know. */
        val name: String,
        /** What the screen writes before the account (`@`); "" for a platform the app does not know. */
        val prefix: String,
        /** What the field starts with: the account the row holds now, or "". */
        val current: String,
        /** A field to type in, with app_accounts.preview beside it; false for a platform the app does not know (kept as it is), and on a day with 3 records. */
        val editable: Boolean,
        /** The lines under the row ("每一列下面的那一行"). */
        val lines: List<String>,
    )

    /** Step 4 as it opens: [FillView] or [DeclaredView]. */
    sealed class AccountsView {
        abstract val title: String
    }

    /** Rows to fill: the card declares nothing, or (several platforms) the list opened with accounts.edit_list. */
    class FillView(
        override val title: String,
        /** The lines above the rows. */
        val lead: List<String>,
        val rows: List<AccountRow>,
        /** The lines below the rows, before the button. */
        val notes: List<String>,
        /** 3 records of the card today: the rows as they are, this sentence, and accounts.restart only. */
        val dailyLimit: String?,
        /** Opened with accounts.edit_list: accounts.keep goes back to what the card declares. */
        val editList: Boolean,
    ) : AccountsView()

    /** An account the card declares now: `name` null where the screens speak of one platform. */
    class Declared(val platform: String, val name: String?, val account: String)

    /** The card declares accounts: what it declares, accounts.refresh, and the other actions. */
    class DeclaredView(
        override val title: String,
        val declaredNow: String,
        val current: List<Declared>,
        /** accounts.last_proof, or accounts.last_proof_today. */
        val last: String?,
        val refresh: String,
        val refreshNote: String,
        /** accounts.switch: one platform, not on a day with 3 records. */
        val switchAccount: String?,
        /** accounts.withdraw, naming the account: one platform, not on a day with 3 records. */
        val withdraw: String?,
        /** accounts.edit_list in place of the two: several platforms, not on a day with 3 records. */
        val editList: String?,
        /** 3 records of the card today: the accounts as they are, this sentence, and accounts.restart only. */
        val dailyLimit: String?,
    ) : AccountsView()

    /** Step 4 after accounts.switch (one platform, the card declares an account). */
    class SwitchView(
        val title: String,
        /** accounts.declared_inline */
        val intro: String,
        /** accounts.switch above the field; null without a field. */
        val heading: String?,
        /** The field, empty; null when no switch is left (and the account was not put there today). */
        val row: AccountRow?,
        /** Below the field: what changing it does and what it uses up; or that no switch is left. */
        val cost: String,
        /** app_accounts.preview_note; null without a field. */
        val previewNote: String?,
        val keep: String,
    )

    private fun accountsTitle(single: String?): String = if (single != null) c.say("accounts.title_single", "platform" to single) else c.say("accounts.title")

    private fun previewNote(single: String?): String = c.say("app_accounts.preview_note", "platform" to (single ?: Platforms.THREADS.name))

    private fun row(slot: CardProof.Slot, daily: Boolean, lines: Boolean, current: String = slot.current ?: ""): AccountRow {
        val p = if (slot.known) Platforms.of(slot.platform) else null
        return AccountRow(
            platform = slot.platform,
            name = p?.name ?: slot.platform,
            prefix = p?.prefix ?: "",
            current = current,
            editable = p != null && !daily,
            lines = if (daily || !lines) emptyList() else rowLines(slot),
        )
    }

    private fun previewNotes(rows: List<AccountRow>, single: String?): List<String> = if (rows.any { it.editable }) listOf(previewNote(single)) else emptyList()

    /** Step 4 as it opens ("4. 你的帳號"): rows to fill when the card declares nothing; what it declares and the actions when it does. */
    fun accountsView(status: CardProof.Status): AccountsView {
        val daily = status.dailyLimit
        val single = onePlatform(status)
        val dailyLimit = if (daily) c.say("stops.daily_limit") else null
        val declared = status.slots.filter { it.current != null }
        if (declared.isNotEmpty()) {
            val current = declared.map {
                val name = if (it.known) Platforms.of(it.platform)?.name ?: it.platform else it.platform
                Declared(it.platform, if (single != null) null else name, if (it.known) Platforms.handle(it.platform, it.current!!) else it.current!!)
            }
            val days = status.daysSince
            val only = if (single != null && !daily) current[0] else null
            return DeclaredView(
                title = accountsTitle(single),
                declaredNow = c.say("accounts.declared_now"),
                current = current,
                last = days?.let { if (it == 0) c.say("accounts.last_proof_today") else c.say("accounts.last_proof", "days_ago" to it) },
                refresh = c.say("accounts.refresh"),
                refreshNote = c.say("accounts.refresh_note"),
                switchAccount = only?.let { c.say("accounts.switch") },
                withdraw = only?.let { c.say("accounts.withdraw", "account" to it.account) },
                editList = if (single == null && !daily) c.say("accounts.edit_list") else null,
                dailyLimit = dailyLimit,
            )
        }
        // Nothing declared now. One platform: no line under a row never declared, and no rules of switching.
        val never = status.lastCardProof == null
        val rows = status.slots.map { row(it, daily, lines = single == null || !never) }
        val rules = when {
            single != null -> emptyList()
            never -> listOf(c.say("accounts.one_per_platform") + c.say("accounts.switches_limited"))
            else -> listOf(c.say("accounts.how_change") + c.say("accounts.switches_limited"))
        }
        return FillView(
            title = accountsTitle(single),
            lead = listOf(if (never) c.say("accounts.none_yet") else c.say("accounts.nothing_now"), if (single != null) c.say("accounts.fill_one_single", "platform" to single) else c.say("accounts.fill_one")),
            rows = rows,
            notes = if (daily) emptyList() else rules + previewNotes(rows, single),
            dailyLimit = dailyLimit,
            editList = false,
        )
    }

    /** Step 4 after accounts.edit_list (several platforms): one row per platform, each changed on its own. */
    fun editListView(status: CardProof.Status): FillView {
        val single = onePlatform(status)
        val rows = status.slots.map { row(it, daily = false, lines = true) }
        return FillView(
            title = accountsTitle(single),
            lead = listOf(c.say("accounts.current")),
            rows = rows,
            notes = listOf(c.say("accounts.how_change") + c.say("accounts.switches_limited")) + previewNotes(rows, single),
            dailyLimit = null,
            editList = true,
        )
    }

    /** The row accounts.switch changes: the one account of a card on one platform; null when it declares none. */
    fun switchSlot(status: CardProof.Status): CardProof.Slot? = status.slots.firstOrNull { it.known && it.current != null }

    /** Step 4 after accounts.switch (one platform): the account now, a field for another, and what it costs. Only for a card [switchSlot] has a row of. */
    fun switchView(status: CardProof.Status): SwitchView {
        val single = onePlatform(status)
        val slot = switchSlot(status)!!
        val now = Platforms.handle(slot.platform, slot.current!!)
        val title = accountsTitle(single)
        val intro = c.say("accounts.declared_inline", "account" to now)
        val keep = c.say("accounts.keep")
        // Used up, and not put there today: no other account can be declared.
        if (!slot.correctionToday && slot.switchesLeft == 0) {
            return SwitchView(title, intro, null, null, c.say("accounts.row_used_up", "switches_used" to slot.switchCount), null, keep)
        }
        val cost = when {
            slot.correctionToday -> c.say("accounts.row_today")
            slot.switchesLeft == 1 -> c.say("confirm.uses_final_switch")
            else -> c.say("accounts.switch_limit", "switches_left" to slot.switchesLeft - 1)
        }
        return SwitchView(title, intro, c.say("accounts.switch"), row(slot, daily = false, lines = false, current = ""), c.say("accounts.switch_effect", "account" to now) + cost, previewNote(single), keep)
    }

    /** The lines under one row of step 4 (card-proof.md, "每一列下面的那一行"). None for a platform the app does not know: that sentence is not written yet. */
    fun rowLines(slot: CardProof.Slot): List<String> {
        if (!slot.known) return emptyList()
        val lastDeclared = slot.lastDeclared ?: return listOf(c.say("accounts.row_unused"))
        val last = Platforms.handle(slot.platform, lastDeclared)
        val lines = mutableListOf<String>()
        if (slot.current == null) lines += c.say("accounts.row_withdrawn", "last_declared" to last)
        lines += when {
            slot.switchCount == 0 -> c.say("accounts.row_no_switches_yet", "switches_left" to slot.switchesLeft)
            slot.switchesLeft > 0 -> c.say("accounts.row_switches", "switches_used" to slot.switchCount, "switches_left" to slot.switchesLeft)
            else -> c.say("accounts.row_used_up", "switches_used" to slot.switchCount)
        }
        // An account put there today can be changed today without a switch, even when none is left.
        if (slot.correctionToday) {
            if (slot.current != null) lines += c.say("accounts.row_today")
        } else if (slot.switchesLeft == 0) {
            lines += if (slot.current != null) c.say("accounts.row_can_clear") else c.say("accounts.row_only_back", "last_declared" to last)
        }
        return lines
    }

    /** What a row does (step 5, "每一列下面寫會發生什麼"; step 6 uses the same). */
    fun kind(platform: String, kind: String, username: String, current: String?, previous: String?): String = when (kind) {
        "first" -> c.say("kinds.first")
        "refresh" -> if (current == username) c.say("kinds.unchanged") else c.say("kinds.again")
        "withdraw" -> c.say("kinds.withdraw")
        else -> c.say("kinds.switch", "previous" to Platforms.handle(platform, previous ?: ""))
    }

    /** What step 5 writes under a row: what it does, and for a switch or a correction what it uses up. */
    fun rowSentences(row: CardProof.Row): String = kind(row.platform, row.kind, row.username, row.current, row.previous) + when {
        row.kind == "correction" -> c.say("confirm.switch_not_counted")
        row.kind != "switch" -> ""
        row.switchesLeft == 0 -> c.say("confirm.uses_final_switch")
        else -> c.say("confirm.uses_switch", "switches_left" to row.switchesLeft!!)
    }

    private fun allUnchanged(rows: List<Triple<String, String, String?>>): Boolean = rows.all { (kind, username, current) -> kind == "refresh" && current == username }

    /** One of the points under step 5's list; `strong`: the words of it in bold ink (confirm.cannot_delete). */
    class ConfirmPoint(val text: String, val strong: String?)

    /** What step 5 says around the list ("5. 確認"). The same choices as confirmView of web/src/ui/messages.ts. */
    class ConfirmView(
        val intro: String,
        /** confirm.withdraw_stays: several platforms, an account withdrawn, the list not empty. */
        val withdrawStays: String?,
        /** confirm.listed_together: several platforms, the list not empty. */
        val listedTogether: String?,
        val points: List<ConfirmPoint>,
        /** By the whole list: the same words as the button of step 4 that led here. */
        val button: String,
    )

    fun confirmView(q: CardProof.Consequence, status: CardProof.Status): ConfirmView {
        val single = onePlatform(status)
        val empty = q.accounts.isEmpty()
        // The points name the platforms of the screens: the one, or each the app knows of the server's table.
        val named = if (single != null) single else status.tablePlatforms.joinToString(c.say("confirm.platform_separator")) { Platforms.of(it)?.name ?: it }
        val notIdentifiable = ConfirmPoint(c.say("confirm.not_identifiable", "platform" to named), null)
        val cannotDelete = c.say("confirm.cannot_delete")
        return ConfirmView(
            intro = if (empty) c.say("confirm.intro_withdraw_all") else if (single != null) c.say("confirm.intro_public") else c.say("confirm.intro"),
            withdrawStays = if (!empty && single == null && q.rows.any { it.kind == "withdraw" }) c.say("confirm.withdraw_stays") else null,
            listedTogether = if (!empty && single == null) c.say("confirm.listed_together") else null,
            points = if (empty) {
                listOf(ConfirmPoint(c.say("confirm.history_stays"), null), notIdentifiable, ConfirmPoint(c.say("confirm.holder_later_withdraw"), null))
            } else {
                listOf(notIdentifiable, ConfirmPoint(c.say("confirm.holder_later", "platform" to named, "cannot_delete" to cannotDelete), cannotDelete))
            },
            button = when {
                empty && single != null && q.rows.size == 1 -> q.rows[0].let { c.say("confirm.button_withdraw", "account" to Platforms.handle(it.platform, it.username)) }
                empty -> c.say("confirm.button_withdraw_all")
                allUnchanged(q.rows.map { Triple(it.kind, it.username, it.current) }) -> c.say("confirm.button_refresh")
                single != null -> c.say("confirm.button_declare_single")
                else -> c.say("confirm.button_declare")
            },
        )
    }

    // After the submission: step 6 (hang it), step 8 (done and share) --------------------

    /** The server's kinds with what each platform declared before: whether every row is unchanged (a card proof again). */
    private fun recordedUnchanged(d: CardProof.Done): Boolean {
        val kinds = d.answer.kinds ?: return false
        val current = d.expected.associate { it.platform to it.current }
        return allUnchanged(kinds.map { Triple(it.kind, it.username, current[it.platform]) })
    }

    /**
     * The title of the last step (card-proof.md, "8. 完成和分享", the table of titles), by what the server says was recorded.
     * [single]: the one platform's name when the screens speak of one platform; then a new declaration (or one again after a
     * withdrawal) is congratulated like a first one, and a switch names the account it is now.
     */
    fun doneTitle(d: CardProof.Done, single: String?): String {
        val kinds = d.answer.kinds ?: return c.say("done.recorded_only")
        if (d.firstRecord) return c.say("finish.first")
        if (d.accounts.isEmpty()) return c.say("done.withdraw_all")
        if (recordedUnchanged(d)) return c.say("done.refresh")
        val k = if (single != null && kinds.size == 1) kinds[0] else null
        if (k != null) {
            val before = d.expected.firstOrNull { it.platform == k.platform }?.current
            if (k.kind == "first" || (k.kind == "refresh" && before == null)) return c.say("finish.first")
            if (k.kind == "switch" || k.kind == "correction") return c.say("finish.switched", "account" to Platforms.handle(k.platform, k.username))
        }
        return c.say("done.changed")
    }

    /** A row of "證明紀錄記下了這一筆": one platform of the record, as the server says it recorded it. */
    class DoneRow(
        val platform: String,
        /** False for a platform the app does not know: its account is shown as it is. */
        val known: Boolean,
        val username: String,
        /** What was recorded there; null where the server has nothing for a platform step 5 showed, or the sentence would name an account the app does not have. */
        val kind: String?,
        /** Where the answer differs from step 5: what step 5 said (done.mismatch_expected). */
        val expected: String?,
        /** Where it differs and the server recorded a switch that step 5 did not call one (done.mismatch_switch_used). */
        val switchUsed: String?,
    )

    /**
     * A button of step 6 that opens an account's profile: it says the short [label] ("打開 Threads"), so that it fits beside
     * "複製證明連結"; a screen reader is [told] the whole of it ("打開 @alice 的 Threads 個人檔案"). [address] is the profile's.
     */
    data class OpensProfile(val label: String, val told: String, val address: String)

    /**
     * What the steps after the submission say (design/copy/card-proof.md, "6. 掛上去" and "8. 完成和分享", each with its part
     * marked app). The same choices as doneView of web/src/ui/messages.ts.
     */
    class DoneView(
        /** The last step's title. */
        val title: String,
        /** The list is empty: no step 6 or 7, no small card; the last step says the links can be taken down. */
        val withdrawAll: Boolean,
        /** Everything withdrawn: finish.unlink_single, or with several platforms done.withdrawn_link. */
        val unlink: String,
        /** The small card's accounts, as they are after this card proof: each with its platform's name, or none where the screens speak of one platform. */
        val card: List<Pair<String?, String>>,
        /** The date the proof log recorded it: the first line of step 6, and of the last step when everything was withdrawn. */
        val recordedOn: String,
        /** hang.title, or with one platform hang.title_single. */
        val hangTitle: String,
        /** Why to hang it: done.anyone, or with one platform hang.why_single. */
        val why: String,
        /** Step 6 asks only whether the link is still there: a card proof again (every row unchanged), with one platform, recorded as step 5 said. */
        val short: Boolean,
        /** The short step 6's question (hang.still_there_single); null when step 6 is the whole one. */
        val stillThere: String?,
        /** "打開你的島民證明看看。", the short step 6's line that opens the card's page. */
        val look: String,
        /** The buttons that open a profile: one per account on a platform the app knows. */
        val profiles: List<OpensProfile>,
        /** The four steps on the platform, until the demonstration takes their place (card-proof.md, "示範"). */
        val steps: List<String>,
        /** Under the steps: a new card's new link (the card's first record), a withdrawn account's link (the list not empty), the other cards that declare an account. */
        val notes: List<String>,
        /** "掛好了嗎？打開你的島民證明看看。", the line that opens the card's page. */
        val hung: String,
        /** finish.ordinal, before the invitation to share; null when the answer had no ordinal. */
        val ordinal: String?,
        /** "分享到 Threads": one per platform the app knows. Each opens the system's share sheet. */
        val shares: List<String>,
        /**
         * What the share sheet gets before the card's address, on the line above it: the sentence with the card's
         * ordinal, or without a number when the answer had none.
         */
        val shareText: String,
        /** done.mismatch, above everything: what the server recorded differs from what step 5 said. */
        val mismatch: String?,
        /** The record as the server says it recorded it: only where that differs from what step 5 said. */
        val showRecord: Boolean,
        /** The proof log's line; null when the answer's kinds could not be read. */
        val record: String?,
        /**
         * Where the answer's kinds could not be read, the sentence that says so under the date. The app's
         * wording is not written yet (card-proof.md, "6. 掛上去", app); until it is, the web's (ios/ does the same).
         */
        val kindsUnreadable: String?,
        val rows: List<DoneRow>,
    )

    fun done(d: CardProof.Done, single: String?): DoneView {
        val expected = d.expected.associateBy { it.platform }
        val kinds = d.answer.kinds
        val withdrawAll = d.accounts.isEmpty()
        val mismatched = d.answer.mismatches.isNotEmpty()
        // A platform step 5 did not show (the server's answer differs) is named as the app knows it.
        val knownOf = { platform: String -> expected[platform]?.known ?: (Platforms.of(platform) != null) }
        val account = { platform: String, username: String -> if (knownOf(platform)) Platforms.handle(platform, username) else username }
        val expectedOf = { platform: String ->
            c.say("done.mismatch_expected", "expected" to (expected[platform]?.let { rowSentences(it) } ?: c.say("done.mismatch_no_platform")))
        }
        val rows = mutableListOf<DoneRow>()
        if (kinds != null) {
            for (k in kinds) {
                val e = expected[k.platform]
                // kinds.switch names the account the screen knew was replaced.
                val previous = e?.previous ?: e?.current
                val sentence = if ((k.kind == "switch" || k.kind == "correction") && previous == null) null else kind(k.platform, k.kind, k.username, e?.current, previous)
                val mismatch = k.platform in d.answer.mismatches
                rows += DoneRow(
                    k.platform, knownOf(k.platform), k.username, sentence,
                    if (mismatch) expectedOf(k.platform) else null,
                    if (mismatch && k.kind == "switch" && e?.kind != "switch") c.say("done.mismatch_switch_used") else null,
                )
            }
            for (e in d.expected) {
                if (kinds.none { it.platform == e.platform }) rows += DoneRow(e.platform, e.known, e.username, null, expectedOf(e.platform), null)
            }
            rows.sortBy { it.platform }
        }
        val withdrew = kinds?.any { it.kind == "withdraw" } ?: d.expected.any { it.kind == "withdraw" }
        val short = single != null && !withdrawAll && !d.firstRecord && !mismatched && recordedUnchanged(d)
        val openProof = c.say("done.open_proof")
        return DoneView(
            title = doneTitle(d, single),
            withdrawAll = withdrawAll,
            unlink = if (single != null) c.say("finish.unlink_single", "platform" to single) else c.say("done.withdrawn_link"),
            card = d.accounts.map { (platform, username) -> (if (single != null) null else if (knownOf(platform)) Platforms.of(platform)?.name ?: platform else platform) to account(platform, username) },
            recordedOn = c.say("done.recorded_on", "date" to d.date),
            hangTitle = if (single != null) c.say("hang.title_single", "platform" to single) else c.say("hang.title"),
            why = if (single != null) c.say("hang.why_single") else c.say("done.anyone"),
            short = short,
            stillThere = if (short) c.say("hang.still_there_single", "platform" to single!!) else null,
            look = c.say("hang.look", "open_proof" to openProof),
            profiles = d.accounts.mapNotNull { (platform, username) ->
                val p = if (knownOf(platform)) Platforms.of(platform) else null
                p?.let { OpensProfile(c.say("hang.open_threads", "platform" to it.name), c.say("done.open_profile", "account" to account(platform, username), "platform" to it.name), it.profileUrl(username)) }
            },
            steps = listOf(c.say("done.step_edit"), c.say("done.step_link"), c.say("done.step_add"), c.say("done.step_paste")),
            notes = listOfNotNull(
                if (d.firstRecord && !withdrawAll) c.say("hang.new_card") else null,
                if (withdrew && !withdrawAll) c.say("done.withdrawn_link") else null,
            ) + (kinds ?: emptyList()).filter { it.kind != "withdraw" && (it.accountCards ?: 0) > 1 }.map { c.say("done.other_cards", "account" to account(it.platform, it.username)) },
            hung = c.say("done.hung", "open_proof" to openProof),
            ordinal = d.answer.ordinal?.let { c.say("finish.ordinal", "ordinal" to thousands(it)) },
            // The button names the platform, as the web's; it opens the system's share sheet (card-proof.md, "8. 完成和分享", app).
            shares = Platforms.known.map { c.say("done.share", "platform" to it.name) },
            shareText = d.answer.ordinal?.let { c.say("done.share_text", "ordinal" to thousands(it)) } ?: c.say("done.share_text_unnumbered"),
            mismatch = if (mismatched) c.say("done.mismatch") else null,
            showRecord = mismatched,
            record = if (kinds == null) null else if (withdrawAll) c.say("done.record_withdraw_all") else if (single != null) c.say("done.record_single") else c.say("done.record_list"),
            kindsUnreadable = if (kinds == null) c.say("done.kinds_unreadable") else null,
            rows = rows,
        )
    }

    private companion object {
        /** A whole number with a comma between groups of three digits, as the card's page writes the ordinal. */
        fun thousands(n: Long): String = n.toString().reversed().chunked(3).joinToString(",").reversed()

        /** Codes of a submission the server did not accept that have no sentence of their own (card-proof.md, step 5). */
        val REJECTED = setOf("scope", "platform", "malformed", "challenge_used", "challenge_attempts", "proof", "root", "date_order")
    }
}
