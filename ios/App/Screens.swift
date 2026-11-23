import Foundation

/// The six screens of the card proof, each from what the flow knows at
/// that step: which sentence of design/copy/card-proof.md goes where (the
/// paragraphs marked "app", and the shared ones where the app has none).
/// Pure functions; the sentences come from `copy`, never from here.
///
/// The rows of steps 4 to 6 follow web/src/ui/messages.ts, which makes the
/// same screens for the web page.
struct Screens {
    let copy: Copy
    /// The site of this build, as a link on the screen writes it: its host.
    let host: String

    typealias Flow = CardProofFlow

    /// The screens speak of one platform (design/copy/card-proof.md,
    /// the section on one platform): the server's table has one platform the app
    /// knows, and the card keeps no account on a platform it does not
    /// know. The platform's name if so.
    static func onePlatform(_ status: Flow.CardStatus) -> String? {
        guard status.knownPlatforms.count == 1, status.rows.allSatisfy(\.known) else { return nil }
        return Platform.of(status.knownPlatforms[0])?.name
    }

    private func more(_ topic: String = "more") -> Block {
        .button(Button(label: copy("links.\(topic)"), action: .help(topic)))
    }

    // Step 1: before starting ------------------------------------------------------------------

    func before() -> Screen {
        // No platform table yet: by the platforms the app has its own definition of.
        let only = Platform.known.count == 1 ? Platform.known[0] : nil
        var blocks: [Block] = [
            .title(copy("before.title")),
            .text(copy("before.prepare_card")),
            .text(copy("before.citizens_only")),
        ]
        if let only {
            blocks.append(.text(copy("before.one_proof_single", ["platform": only.name])))
        } else {
            blocks += [.text(copy("before.one_proof")), .strong(copy("before.listed_together"))]
        }
        blocks += [
            .question(copy("before.why_physical"), [copy("before.why_physical_card"), copy("before.why_physical_mobile")]),
            .question(copy("before.how_to_get"), [copy("before.how_to_get_counter"), copy("before.how_to_get_moica")]),
        ]
        return Screen(step: 1, blocks: blocks, buttons: [Button(label: copy("common.next"), action: .start)])
    }

    // The two lists ----------------------------------------------------------------

    /// The items of a list: those before `reached` are done, the one at
    /// `reached` is in progress while `running`, or stopped there with
    /// `why`; the ones after it show nothing yet.
    func items(_ labels: [String], reached: Int, running: Bool, why: [String]?) -> [Item] {
        labels.enumerated().map { index, label in
            if index < reached { return Item(label: label, state: .done, status: copy("common.done")) }
            if index == reached, let why { return Item(label: label, state: .halted, status: copy("common.halted"), why: why) }
            if index == reached, running { return Item(label: label, state: .working, status: copy("common.working")) }
            return Item(label: label, state: .pending, status: "")
        }
    }

    // Step 2: reading the card ------------------------------------------------------------------

    /// `reached`: how many items of the list are done (0 to 4). `stop`:
    /// why it stopped at the next one.
    func read(reached: Int, running: Bool, stop: Flow.Stop?) -> Screen {
        let labels = [copy("read.server"), copy("app_read.certificate"), copy("read.check"), copy("read.crl")]
        let done = reached == labels.count
        let spot = copy("app_read.spot_iphone")
        let blocks: [Block] = [
            .title(copy("read.title")),
            .text(done ? copy("app_read.lift") : copy("app_read.how", ["spot": spot])),
            .items(items(labels, reached: reached, running: running, why: stop.map { message($0, tap: 1) })),
        ]
        var buttons: [Button]
        if done {
            buttons = [Button(label: copy("common.next"), action: .toPIN)]
        } else if let stop {
            // No card came: the same tap again. Anything else: the card is read again from the start.
            buttons = [stop == .card(.noTap) ? Button(label: copy("app_read.tap_again"), action: .readCard) : Button(label: copy("app_read.restart"), action: .readAgain)]
        } else {
            buttons = [Button(label: copy("common.back"), action: .back, enabled: !running), Button(label: copy("app_read.tap_card"), action: .readCard, enabled: !running)]
        }
        return Screen(step: 2, blocks: blocks, buttons: buttons)
    }

    // Step 3: the PIN ------------------------------------------------------------------

    enum PINState: Equatable {
        /// Waiting for the PIN, with what went wrong the last time, if anything.
        case waiting(String?)
        /// Tap 2 is under way.
        case tapping
        /// The card signed; the card's state is being asked for.
        case signed
        /// Another card than the one read: the PIN is kept, the tap can be made again.
        case otherCard(String)
        /// The card proof stopped here.
        case stopped([String])
    }

    func pin(name: String, state: PINState) -> Screen {
        var blocks: [Block] = [
            .title(copy("pin.title")),
            .cardName(label: copy("pin.card_read"), name: name, note: copy("pin.name_note")),
            .pinField(label: copy("pin.label")),
        ]
        var buttons = [Button(label: copy("common.back"), action: .back), Button(label: copy("pin.confirm_card"), action: .confirmCard)]
        switch state {
        case .waiting(let message):
            if let message { blocks.append(.message(message)) }
        case .tapping:
            buttons = buttons.map { Button(label: $0.label, action: $0.action, enabled: false) }
        case .signed:
            blocks.append(.busy(copy("app_pin.signed")))
            buttons = buttons.map { Button(label: $0.label, action: $0.action, enabled: false) }
        case .otherCard(let message):
            blocks.append(.message(message))
            buttons = [Button(label: copy("app_read.tap_again"), action: .confirmCard)]
        case .stopped(let why):
            blocks += why.map(Block.message)
            buttons = [Button(label: copy("app_read.restart"), action: .readAgain)]
        }
        blocks += [.points([copy("pin.purpose"), copy("app_pin.stays"), copy("pin.card_and_pin")]), more()]
        return Screen(step: 3, blocks: blocks, buttons: buttons)
    }

    // Step 4: the card's accounts ------------------------------------------------------------------

    /// The lines under one row (step 4, the table of the line under each row).
    func rowLines(_ row: Flow.StatusRow) -> [String] {
        guard row.known else { return [copy("accounts.row_unknown_platform")] }
        guard let lastDeclared = row.lastDeclared else { return [copy("accounts.row_unused")] }
        let used = String(row.switchCount)
        let left = String(row.switchesLeft)
        let count = row.switchCount == 0
            ? copy("accounts.row_no_switches_yet", ["switches_left": left])
            : row.switchesLeft > 0
                ? copy("accounts.row_switches", ["switches_used": used, "switches_left": left])
                : copy("accounts.row_used_up", ["switches_used": used])
        let last = Platform.handle(row.platform, lastDeclared)
        var lines: [String] = []
        if row.current == nil { lines.append(copy("accounts.row_withdrawn", ["last_declared": last])) }
        lines.append(count)
        // An account put there today can be changed today without a switch, even when none is left.
        if row.correctionToday {
            if row.current != nil { lines.append(copy("accounts.row_today")) }
        } else if row.switchesLeft == 0 {
            lines.append(row.current != nil ? copy("accounts.row_can_clear") : copy("accounts.row_only_back", ["last_declared": last]))
        }
        return lines
    }

    /// `typed`: what each field holds; `errors`: what is wrong with a
    /// row, by platform; `message`: what is wrong with the whole list.
    func accounts(_ status: Flow.CardStatus, typed: [String: String], errors: [String: String], message: String?) -> Screen {
        let single = Self.onePlatform(status)
        let daily = status.dailyLimit
        var blocks: [Block] = [.title(single.map { copy("accounts.title_single", ["platform": $0]) } ?? copy("accounts.title"))]
        let fillOne = single.map { copy("accounts.fill_one_single", ["platform": $0]) } ?? copy("accounts.fill_one")
        let declared = status.rows.contains { $0.current != nil }
        var previews = false
        if declared {
            let last = status.daysSince.map { $0 <= 0 ? copy("accounts.last_card_proof_today") : copy("accounts.last_card_proof", ["days_ago": String($0)]) } ?? ""
            blocks.append(.text(copy("accounts.current") + last))
        } else {
            blocks += [.text(status.lastCardProof == nil ? copy("accounts.none_yet") : copy("accounts.nothing_now")), .text(fillOne)]
        }
        for row in status.rows {
            guard row.known, let platform = Platform.of(row.platform) else {
                // Shown as the server sent it; kept in the list as it is.
                blocks.append(.row(name: row.platform, account: row.current ?? "", lines: daily ? [] : rowLines(row)))
                continue
            }
            if daily {
                blocks.append(.row(name: platform.name, account: row.current.map { Platform.handle(row.platform, $0) } ?? "", lines: []))
                continue
            }
            previews = true
            blocks.append(.account(AccountRow(
                platform: row.platform,
                name: platform.name,
                prefix: platform.prefix,
                text: typed[row.platform] ?? "",
                preview: Button(label: copy("app_accounts.preview"), action: .preview(row.platform)),
                lines: rowLines(row),
                error: errors[row.platform])))
        }
        if let message { blocks.append(.message(message)) }
        if daily {
            blocks.append(.text(copy("stops.daily_limit")))
            return Screen(step: 4, blocks: blocks, buttons: [Button(label: copy("accounts.restart"), action: .restart)])
        }
        let limited = copy("accounts.switches_limited")
        if declared {
            blocks += [.text(copy("accounts.how_refresh")), .text(copy("accounts.how_change") + limited), more()]
        } else if status.lastCardProof != nil {
            blocks += [.text(copy("accounts.how_change") + limited), more()]
        } else {
            let onePer = single.map { copy("accounts.one_per_platform_single", ["platform": $0]) } ?? copy("accounts.one_per_platform")
            blocks += [.text(onePer + limited), more()]
        }
        if previews, let name = single ?? Platform.known.first?.name {
            blocks.append(.text(copy("app_accounts.preview_note", ["platform": name])))
        }
        blocks += [.text(copy("accounts.no_check")), .text(copy("accounts.acknowledged")), more()]
        return Screen(
            step: 4, blocks: blocks,
            buttons: [Button(label: copy("common.next"), action: .toConfirm)],
            cancel: Button(label: copy("common.cancel"), action: .restart))
    }

    // Step 5: confirming ----------------------------------------------------------------------

    /// What a row does (step 5, the table of what each row does), and for a
    /// switch or a correction what it uses up.
    func rowSentences(_ row: Flow.ConsequenceRow) -> [String] {
        var lines: [String]
        switch row.kind {
        case "first": lines = [copy("kinds.first")]
        case "refresh": lines = [row.current == row.username ? copy("kinds.unchanged") : copy("kinds.again")]
        case "withdraw": lines = [copy("kinds.withdraw")]
        default: lines = [copy("kinds.switch", ["previous": Platform.handle(row.platform, row.previous ?? "")])]
        }
        if row.kind == "correction" {
            lines.append(copy("confirm.switch_not_counted"))
        } else if row.kind == "switch" {
            lines.append(row.switchesLeft == 0 ? copy("confirm.uses_final_switch") : copy("confirm.uses_switch", ["switches_left": String(row.switchesLeft ?? 0)]))
        }
        return lines
    }

    private func row(_ row: Flow.ConsequenceRow, lines: [String]) -> Block {
        .row(
            name: row.known ? Platform.of(row.platform)?.name ?? row.platform : row.platform,
            account: row.known ? Platform.handle(row.platform, row.username) : row.username,
            lines: lines)
    }

    private static func allUnchanged(_ rows: [Flow.ConsequenceRow]) -> Bool {
        rows.allSatisfy { $0.kind == "refresh" && $0.current == $0.username }
    }

    func confirm(_ status: Flow.CardStatus, _ consequence: Flow.Consequence) -> Screen {
        let single = Self.onePlatform(status)
        let empty = consequence.accounts.isEmpty
        var blocks: [Block] = [
            .title(copy("confirm.title")),
            .text(empty ? copy("confirm.intro_withdraw_all") : single != nil ? copy("confirm.intro_single") : copy("confirm.intro")),
        ]
        blocks += consequence.rows.map { row($0, lines: rowSentences($0)) }
        blocks += [
            .pair(copy("confirm.date"), consequence.today),
            .pair(copy("confirm.short_id_label"), copy("confirm.short_id", ["short_id": status.shortID])),
        ]
        if consequence.rows.contains(where: { $0.kind == "withdraw" }) { blocks.append(.text(copy("confirm.withdraw_stays"))) }
        if !empty {
            blocks.append(.strong(single.map { copy("confirm.listed_single", ["platform": $0]) } ?? copy("confirm.listed_together")))
        }
        blocks.append(.points([copy("confirm.no_identity"), (empty ? copy("confirm.later_withdraw") : copy("confirm.later")) + copy("confirm.permanent")]))
        let button = empty
            ? copy("confirm.button_withdraw_all")
            : Self.allUnchanged(consequence.rows)
                ? copy("confirm.button_refresh")
                : single != nil ? copy("confirm.button_declare_single") : copy("confirm.button_declare")
        return Screen(
            step: 5, blocks: blocks,
            buttons: [Button(label: copy("common.back"), action: .back), Button(label: button, action: .declare)],
            cancel: Button(label: copy("common.cancel"), action: .restart))
    }

    /// Step 5 once the button was pressed. `reached`: how many items are
    /// done (0 to 4); `stop`: why it stopped at the next one, and whether
    /// the record can be sent again as it is.
    func progress(reached: Int, stop: Flow.Stop?, submitFailed: Bool = false) -> Screen {
        // The seconds are the copy's figure for an iPhone (card-proof.md, step 5, "app").
        let labels = [copy("progress.server"), copy("app_progress.sign"), copy("app_progress.compute", ["seconds": "5"]), copy("progress.submit")]
        var blocks: [Block] = [.title(copy("progress.title")), .text(copy("app_progress.keep_open"))]
        // The card signed: it can be taken away.
        if reached >= 2 { blocks.append(.text(copy("app_read.lift"))) }
        let why = stop.map { submitFailed ? [copy("stops.submit_failed")] : message($0, tap: 3) }
        blocks.append(.items(items(labels, reached: reached, running: stop == nil, why: why)))
        if reached == 2, stop == nil { blocks += [.text(copy("progress.zero_knowledge")), more()] }
        guard let stop else { return Screen(step: 5, blocks: blocks) }
        if stop == .card(.otherCard) {
            // The PIN is still there: only this tap again.
            return Screen(
                step: 5, blocks: blocks,
                buttons: [Button(label: copy("app_read.tap_again"), action: .signAgain)],
                cancel: Button(label: copy("common.cancel"), action: .restart))
        }
        if stop == .dateChanged {
            return Screen(step: 5, blocks: blocks, buttons: [Button(label: copy("accounts.restart"), action: .restart)])
        }
        var buttons = [Button(label: copy("app_read.restart"), action: .readAgain)]
        if submitFailed { buttons.append(Button(label: copy("progress.retry"), action: .submitAgain)) }
        return Screen(step: 5, blocks: blocks, buttons: buttons)
    }

    // Step 6: done ----------------------------------------------------------------------

    /// The title of step 6 (card-proof.md, the table of titles), by what
    /// the server says was recorded.
    private func doneTitle(_ done: Flow.Done) -> String {
        guard let kinds = done.answer.kinds else { return copy("done.recorded_only") }
        if done.firstRecord { return copy("done.first") }
        if done.accounts.isEmpty { return copy("done.withdraw_all") }
        let current = Dictionary(done.expected.map { ($0.platform, $0.current) }, uniquingKeysWith: { first, _ in first })
        let unchanged = kinds.allSatisfy { $0.kind == "refresh" && current[$0.platform] == .some($0.username) }
        return unchanged ? copy("done.refresh") : copy("done.changed")
    }

    /// The rows of "證明紀錄記下了這一筆": one for every platform the server
    /// says the record has a kind on, and one for every platform step 5
    /// showed that the answer does not have, in ascending order of
    /// platform. Under a row: what was recorded; where it differs from
    /// step 5, what step 5 said; and that a switch was used when step 5
    /// did not say one would be. The same choices as doneView of
    /// web/src/ui/messages.ts.
    private func recordedRows(_ done: Flow.Done, kinds: [Flow.Recorded]) -> [Block] {
        let expected = Dictionary(done.expected.map { ($0.platform, $0) }, uniquingKeysWith: { first, _ in first })
        // A platform step 5 did not show (the server's answer differs) is named as the app knows it.
        func known(_ platform: String) -> Bool { expected[platform]?.known ?? (Platform.of(platform) != nil) }
        func expectedLine(_ platform: String) -> String {
            let said = expected[platform].map { rowSentences($0).joined() } ?? copy("done.mismatch_no_platform")
            return copy("done.mismatch_expected", ["expected": said])
        }
        var rows: [(platform: String, block: Block)] = kinds.map { kind in
            let shown = expected[kind.platform]
            // kinds.switch names the account the screen knew was replaced.
            let previous = shown?.previous ?? shown?.current
            var lines: [String] = []
            if !((kind.kind == "switch" || kind.kind == "correction") && previous == nil) {
                let recorded = Flow.ConsequenceRow(
                    platform: kind.platform, known: known(kind.platform), kind: kind.kind, username: kind.username,
                    current: shown?.current, previous: previous, switchesLeft: nil)
                lines.append(rowSentences(recorded)[0])
            }
            if done.answer.mismatches.contains(kind.platform) {
                lines.append(expectedLine(kind.platform))
                if kind.kind == "switch", shown?.kind != "switch" { lines.append(copy("done.mismatch_switch_used")) }
            }
            return (kind.platform, .row(
                name: known(kind.platform) ? Platform.of(kind.platform)?.name ?? kind.platform : kind.platform,
                account: known(kind.platform) ? Platform.handle(kind.platform, kind.username) : kind.username,
                lines: lines))
        }
        for shown in done.expected where !kinds.contains(where: { $0.platform == shown.platform }) {
            rows.append((shown.platform, row(shown, lines: [expectedLine(shown.platform)])))
        }
        return rows.sorted { $0.platform < $1.platform }.map(\.block)
    }

    /// `single`: the one platform's name, as step 5 decided it. `copied`:
    /// the link was copied.
    func done(_ done: Flow.Done, single: String?, copied: Bool) -> Screen {
        let withdrawAll = done.accounts.isEmpty
        let kinds = done.answer.kinds
        var blocks: [Block] = []
        // What the proof log recorded is not what step 5 said: first of all, above the title.
        if !done.answer.mismatches.isEmpty { blocks.append(.message(copy("done.mismatch"))) }
        blocks.append(.title(doneTitle(done)))
        let shortID = copy("confirm.short_id", ["short_id": done.shortID])
        if !withdrawAll {
            blocks.append(.heading(copy("done.proof")))
            blocks += done.accounts.map { account in
                Block.row(
                    name: Platform.of(account.platform)?.name ?? account.platform,
                    account: Platform.handle(account.platform, account.username),
                    lines: [])
            }
            blocks += [
                .pair(copy("confirm.date"), done.date),
                .pair(copy("confirm.short_id_label"), shortID),
                .hand(copy("done.hand_ai")),
                .hand(copy("done.hand_profile")),
                .heading(copy("done.put_up")),
                .text(single.map { copy("done.put_link_single", ["platform": $0]) } ?? copy("done.put_link")),
                .link("\(host)/p/\(done.shortID)"),
                .button(Button(label: copied ? copy("done.copied") : copy("done.copy"), action: .copyLink)),
            ]
            // The account on a platform the app can open.
            if let platform = done.accounts.compactMap({ Platform.of($0.platform) }).first {
                blocks += [
                    .button(Button(label: copy("app_done.open_platform", ["platform": platform.name]), action: .openPlatform)),
                    .text(copy("app_done.how_to_put", ["platform": platform.name])),
                ]
            }
            if done.firstRecord { blocks.append(.text(copy("done.new_card"))) }
            let withdrew = kinds.map { $0.contains { $0.kind == "withdraw" } } ?? done.expected.contains { $0.kind == "withdraw" }
            if withdrew { blocks.append(.text(copy("done.withdrawn_link"))) }
            blocks.append(.button(Button(label: copy("links.proof"), action: .openProof)))
        }
        blocks += [.heading(copy("done.recorded")), .text(done.date)]
        if let kinds {
            blocks.append(.text(withdrawAll ? copy("done.record_withdraw_all") : single != nil ? copy("done.record_single") : copy("done.record_list")))
            blocks += recordedRows(done, kinds: kinds)
            blocks.append(.text(copy("done.short_id", ["short_id": done.shortID])))
            // An account of the list that other cards declare too.
            blocks += kinds.filter { $0.kind != "withdraw" && ($0.accountCards ?? 0) > 1 }.map { kind in
                let account = (done.expected.first { $0.platform == kind.platform }?.known ?? (Platform.of(kind.platform) != nil))
                    ? Platform.handle(kind.platform, kind.username) : kind.username
                return .text(copy("done.other_cards", ["account": account]))
            }
        } else {
            // The record is in the proof log; what it is on each platform the app could not read.
            blocks.append(.text(copy("done.kinds_unreadable")))
        }
        var points: [String] = []
        if !withdrawAll { points += [single != nil ? copy("done.advice_single") : copy("done.advice"), copy("done.renamed")] }
        points.append(copy("done.trust"))
        blocks += [.points(points), more("verify")]
        return Screen(step: 6, blocks: blocks, buttons: [Button(label: copy("done.restart"), action: .restart)])
    }

    // Why a step stopped -------------------------------------------------------------

    /// The sentence for a stop, and after it the server's request ID when
    /// there is one. `tap`: in which tap a card failure happened (the
    /// sentences differ). Where the copy has no sentence the screen shows
    /// the code alone, as the web page does (web/src/ui/messages.ts): a
    /// reason code the app does not know, a step called out of order.
    func message(_ stop: Flow.Stop, tap: Int) -> [String] {
        switch stop {
        case .card(.noTap): return [copy("app_stops.no_tap", ["spot": copy("app_read.spot_iphone")])]
        case .card(.pinIncorrect): return [copy("pin.pin_incorrect")]
        case .card(.otherCard): return [tap == 3 ? copy("app_stops.other_card_declare") : copy("app_stops.other_card")]
        case .card(.failed(let code)): return [copy("stops.card_error", ["code": code])]
        case .certificate(let problem, let date):
            let day = date.flatMap(Self.dateOfCertificateTime)
            switch (problem, day) {
            case ("expired", let day?): return [copy("stops.expired", ["expiry_date": day])]
            case ("not_yet_valid", let day?): return [copy("stops.not_yet_valid", ["valid_from": day])]
            case ("not_citizen_primary", _): return [copy("stops.not_citizen_primary")]
            case ("unsupported_format", _): return [copy("stops.unsupported_format")]
            case ("ambiguous_certificate", _): return [copy("stops.two_certificates")]
            case ("unknown_issuer", _): return [copy("stops.unknown_issuer")]
            case ("no_certificate", _): return [copy("app_stops.no_certificate")]
            default: return [problem]
            }
        case .revocation(let problem, let days):
            switch (problem, days) {
            case ("crl_stale", let days?): return [copy("stops.crl_stale", ["crl_days": String(days)])]
            case ("crl_rollback", _): return [copy("app_stops.crl_rollback")]
            case ("revoked", _): return [copy("stops.revoked")]
            default: return [copy("stops.crl_unavailable", ["code": problem])]
            }
        case .cardSignature: return [copy("stops.card_error", ["code": "card_signature"])]
        case .artifact: return [copy("stops.artifact")]
        case .core: return [copy("stops.engine")]
        case .username(let platform):
            return [Platform.of(platform).map { copy($0.formatHint) } ?? copy("accounts.format_no_hint")]
        case .blocked(let reason, _):
            return [reason == "empty" ? copy("accounts.need_one") : reason == "daily_limit" ? copy("stops.daily_limit") : copy("accounts.row_cannot_switch")]
        case .challengeNotToday: return [copy("app_stops.date_mismatch")]
        case .dateChanged: return [copy("stops.date_changed")]
        case .state: return ["state"]
        case .server(let failure):
            let sentence: String
            switch failure.code {
            case "challenge_unknown": sentence = copy("stops.challenge_expired")
            case "crl_stale": sentence = copy("stops.server_crl_stale")
            case "daily_limit": sentence = copy("stops.daily_limit")
            case "switch_limit": sentence = copy("stops.switch_limit")
            case "empty": sentence = copy("stops.empty")
            case "switch_restricted": sentence = copy("stops.switch_restricted")
            case "scope", "platform", "malformed", "challenge_used", "challenge_attempts", "proof", "root", "date_order":
                sentence = copy("stops.rejected", ["code": failure.code])
            default: sentence = copy("stops.server_unreadable", ["code": failure.code])
            }
            return [sentence] + (failure.requestID.map { [copy("stops.request_id", ["request_id": $0])] } ?? [])
        }
    }

    /// A certificate's time, YYMMDDHHMMSS (UTC), as its date in Taiwan.
    static func dateOfCertificateTime(_ time: String) -> String? {
        let digits = time.utf8.map { Int($0) - 48 }
        guard digits.count == 12, digits.allSatisfy({ (0...9).contains($0) }) else { return nil }
        let pair = { (i: Int) in digits[i] * 10 + digits[i + 1] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let parts = DateComponents(year: 2000 + pair(0), month: pair(2), day: pair(4), hour: pair(6), minute: pair(8), second: pair(10))
        return calendar.date(from: parts).map(CardProofFlow.dateInTaiwan)
    }
}
