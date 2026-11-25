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
            CardException.Reason.NO_TAP.name -> c.say("app_stops.no_tap", "spot" to c.say("app_read.spot_android"))
            CardException.Reason.DROPPED.name -> when (at) {
                At.READ -> c.say("app_stops.read_dropped")
                At.PIN -> c.say("app_stops.dropped_pin_kept")
                At.DECLARE -> c.say("app_stops.dropped")
            }
            // At tap 3 the card had taken this PIN at tap 2: the PIN stays, as when the card left later.
            CardException.Reason.PIN_MAYBE_SENT.name -> if (at == At.DECLARE) c.say("app_stops.dropped") else c.say("app_stops.pin_maybe_received")
            CardException.Reason.PIN_INCORRECT.name -> c.say("pin.pin_incorrect")
            CardException.Reason.LOCKED.name -> c.say("stops.card_locked")
            CardException.Reason.NFC_OFF.name -> if (at == At.READ) c.say("app_stops.nfc_off") else null
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
        "server" -> when (val code = stop.values.getValue("code")) {
            "network" -> if (at == At.DECLARE && stop.values["submitting"] == "true") c.say("stops.submit_failed") else c.say("stops.server_unreadable", "code" to code)
            "crl_stale" -> c.say("stops.server_crl_stale")
            "daily_limit" -> c.say("stops.daily_limit")
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

    /** The lines above the list of step 4. */
    fun accountsLead(status: CardProof.Status, single: String?): List<String> {
        val fillOne = if (single != null) c.say("accounts.fill_one_single", "platform" to single) else c.say("accounts.fill_one")
        val days = status.daysSince
        return when {
            status.slots.any { it.current != null } && days != null -> listOf(
                c.say("accounts.current") + if (days == 0) c.say("accounts.last_card_proof_today") else c.say("accounts.last_card_proof", "days_ago" to days),
            )
            days != null -> listOf(c.say("accounts.nothing_now"), fillOne)
            else -> listOf(c.say("accounts.none_yet"), fillOne)
        }
    }

    /** The notes below the list of step 4, before the button. */
    fun accountsNotes(status: CardProof.Status, single: String?): List<String> {
        if (status.dailyLimit) return emptyList()
        val change = c.say("accounts.how_change") + c.say("accounts.switches_limited")
        val preview = c.say("app_accounts.preview_note", "platform" to (single ?: Platforms.THREADS.name))
        return when {
            status.slots.any { it.current != null } -> listOf(c.say("accounts.how_refresh"), change, preview)
            status.lastCardProof != null -> listOf(change, preview)
            else -> listOf(
                (if (single != null) c.say("accounts.one_per_platform_single", "platform" to single) else c.say("accounts.one_per_platform")) + c.say("accounts.switches_limited"),
                preview,
            )
        }
    }

    /** The sentence under step 4's button: the system cannot tell whose an account is. */
    fun notYours(single: String?): String = if (single != null) c.say("accounts.not_yours_single", "platform" to single) else c.say("accounts.not_yours")

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

    /** The button of step 5, by the whole list. */
    fun confirmButton(q: CardProof.Consequence, single: String?): String = when {
        q.accounts.isEmpty() -> c.say("confirm.button_withdraw_all")
        allUnchanged(q.rows.map { Triple(it.kind, it.username, it.current) }) -> c.say("confirm.button_refresh")
        single != null -> c.say("confirm.button_declare_single")
        else -> c.say("confirm.button_declare")
    }

    /** The title of step 6 (card-proof.md, the table of titles), by what the server says was recorded. */
    fun doneTitle(d: CardProof.Done): String {
        val kinds = d.answer.kinds ?: return c.say("done.recorded_only")
        val current = d.expected.associate { it.platform to it.current }
        return when {
            d.firstRecord -> c.say("done.first")
            d.accounts.isEmpty() -> c.say("done.withdraw_all")
            allUnchanged(kinds.map { Triple(it.kind, it.username, current[it.platform]) }) -> c.say("done.refresh")
            else -> c.say("done.changed")
        }
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

    /** What step 6 says (design/copy/card-proof.md, "6. 完成"). The same choices as doneView of web/src/ui/messages.ts. */
    class DoneView(
        val title: String,
        /** The list is empty: no small card, no hanging, nothing to do besides. */
        val withdrawAll: Boolean,
        /** The small card's accounts, as they are after this card proof: each with its platform's name, or none where the screens speak of one platform. */
        val card: List<Pair<String?, String>>,
        /** The date the proof log recorded it. */
        val recordedOn: String,
        val hangTitle: String,
        val anyone: String,
        /** "打開 @alice 的 Threads 個人檔案" and the address it opens: one per account on a platform the app knows. */
        val profiles: List<Pair<String, String>>,
        /** What can be done besides: share the card's page, the sentence that names a platform and the button. One per platform the app knows. */
        val shares: List<Pair<String, String>>,
        /**
         * What the share sheet gets before the card's address, on the line above it: the sentence with the card's
         * ordinal, or without a number when the answer had none (design/copy/card-proof.md, "6. 完成").
         */
        val shareText: String,
        /** "掛好了嗎？打開你的島民證明看看。", the line that opens the card's page. */
        val hung: String,
        /** The card's first record: a new card has a new link (done.new_card). */
        val newCard: Boolean,
        /** done.mismatch, above the title: what the server recorded differs from what step 5 said. */
        val mismatch: String?,
        /** The record as the server says it recorded it: only where that differs from what step 5 said. */
        val showRecord: Boolean,
        /** The proof log's line; null when the answer's kinds could not be read. */
        val record: String?,
        /**
         * Where the answer's kinds could not be read, the sentence that says so instead of the rows. The app's
         * wording is not written yet (card-proof.md, "完成", app); until it is, the web's (ios/ does the same).
         */
        val kindsUnreadable: String?,
        val rows: List<DoneRow>,
        /** One per account of the list that other cards declare too (`account_cards` above 1). */
        val otherCards: List<String>,
        /** An account was withdrawn: its link can be taken down. */
        val withdrawnLink: Boolean,
    )

    fun done(d: CardProof.Done, single: String?): DoneView {
        val expected = d.expected.associateBy { it.platform }
        val kinds = d.answer.kinds
        val withdrawAll = d.accounts.isEmpty()
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
        return DoneView(
            title = doneTitle(d),
            withdrawAll = withdrawAll,
            card = d.accounts.map { (platform, username) -> (if (single != null) null else if (knownOf(platform)) Platforms.of(platform)?.name ?: platform else platform) to account(platform, username) },
            recordedOn = c.say("done.recorded_on", "date" to d.date),
            hangTitle = if (single != null) c.say("done.hang_title_single", "platform" to single) else c.say("done.hang_title"),
            anyone = if (single != null) c.say("done.anyone_single") else c.say("done.anyone"),
            profiles = d.accounts.mapNotNull { (platform, username) ->
                val p = if (knownOf(platform)) Platforms.of(platform) else null
                p?.let { c.say("done.open_profile", "account" to account(platform, username), "platform" to it.name) to it.profileUrl(username) }
            },
            // The button opens the system's share sheet, not the platform: it says only 分享 (design/copy/card-proof.md, "6. 完成", app).
            shares = Platforms.known.map { c.say("done.share_note", "platform" to it.name) to c.say("app_done.share") },
            shareText = d.answer.ordinal?.let { c.say("done.share_text", "ordinal" to thousands(it)) } ?: c.say("done.share_text_unnumbered"),
            hung = c.say("done.hung", "open_proof" to c.say("done.open_proof")),
            newCard = d.firstRecord,
            mismatch = if (d.answer.mismatches.isNotEmpty()) c.say("done.mismatch") else null,
            showRecord = d.answer.mismatches.isNotEmpty(),
            record = if (kinds == null) null else if (withdrawAll) c.say("done.record_withdraw_all") else if (single != null) c.say("done.record_single") else c.say("done.record_list"),
            kindsUnreadable = if (kinds == null) c.say("done.kinds_unreadable") else null,
            rows = rows,
            otherCards = (kinds ?: emptyList()).filter { it.kind != "withdraw" && (it.accountCards ?: 0) > 1 }.map { c.say("done.other_cards", "account" to account(it.platform, it.username)) },
            withdrawnLink = kinds?.any { it.kind == "withdraw" } ?: d.expected.any { it.kind == "withdraw" },
        )
    }

    private companion object {
        /** A whole number with a comma between groups of three digits, as the card's page writes the ordinal. */
        fun thousands(n: Long): String = n.toString().reversed().chunked(3).joinToString(",").reversed()

        /** Codes of a submission the server did not accept that have no sentence of their own (card-proof.md, step 5). */
        val REJECTED = setOf("scope", "platform", "malformed", "challenge_used", "challenge_attempts", "proof", "root", "date_order")
    }
}
