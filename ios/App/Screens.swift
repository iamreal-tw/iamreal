import Foundation

/// The screens of the card proof's eight steps, each from what the flow knows at
/// that step: which sentence of design/copy/card-proof.md goes where (the
/// paragraphs marked "app", and the shared ones where the app has none).
/// Pure functions; the sentences come from `copy`, never from here.
///
/// The rows of steps 4 to 6 follow web/src/ui/messages.ts, which makes the
/// same screens for the web page.
struct Screens {
    let copy: Copy
    /// The app's own sentences (design/copy/app.json): the header's
    /// settings, and how a reminder's day and time are written.
    let appCopy: Copy
    /// The site of this build, as a link on the screen writes it: its host.
    let host: String
    /// The build has a page in the store that a button can open.
    var storePage = false

    /// The store the app is updated from, as the copy's `{store}` (design/copy/card-proof.md: App Store on an iPhone).
    private static let store = "App Store"

    typealias Flow = CardProofFlow

    /// How many steps the app's card proof has (card-proof.md: 8 in the
    /// app, where the reminder is a step; 7 on the web page).
    static let steps = 8

    /// The screens speak of one platform (design/copy/card-proof.md,
    /// the section on one platform): the server's table has one platform the app
    /// knows, and the card keeps no account on a platform it does not
    /// know. The platform's name if so.
    static func onePlatform(_ status: Flow.CardStatus) -> String? {
        guard status.knownPlatforms.count == 1, status.rows.allSatisfy(\.known) else { return nil }
        return Platform.of(status.knownPlatforms[0])?.name
    }

    // Step 1: before starting ------------------------------------------------------------------

    /// The way to the app's page in the store; none in a build that opens no such page (the development build, AppEnvironment).
    private var update: Button? {
        storePage ? Button(label: copy("app_before.update", ["store": Self.store]), action: .openStore) : nil
    }

    /// In the place of step 1 from the day the server's lowest version
    /// starts on, for a build older than it (card-proof.md, step 1, "app";
    /// ADR-0035): nothing leads to a card or a PIN. `from`: that day.
    func tooOld(from: String) -> Screen {
        var blocks: [Block] = [
            .title(copy("app_before.too_old_title")),
            .text(copy("app_before.too_old", ["min_app_from": from])),
            .text(copy("app_before.nothing_sent")),
        ]
        if let update { blocks.append(.button(update, main: true)) }
        blocks.append(.small(copy("app_before.or_reader", ["domain": host])))
        return Screen(step: 0, blocks: blocks, settings: settingsButton)
    }

    /// In the place of step 1 on a phone that cannot read a card
    /// (card-proof.md, step 1, "app"): nothing leads to a tap.
    func noNFC() -> Screen {
        Screen(
            step: 0,
            blocks: [.title(copy("app_before.no_nfc_title")), .text(copy("app_before.no_nfc")), .text(copy("app_before.no_nfc_reader", ["domain": host]))],
            settings: settingsButton)
    }

    /// `notice`: on top, when the app was opened from the reminder.
    /// `paused`: the operator stopped taking card proofs, as the server's
    /// config said: said in place of common.next (card-proof.md, step 1).
    /// `updateFrom`: the day from which this version can no longer do a
    /// card proof, for a build older than the server's lowest: said above
    /// everything, and a card proof goes on as usual. `idle`: the card
    /// proof came back here after five minutes. `busy`: the server turned
    /// the start away as too many: said right above common.next, which
    /// stays (card-proof.md, step 1, 人太多的時候). `starting`: common.next
    /// was pressed and the server has not answered yet.
    func before(notice: Notice? = nil, paused: Bool = false, updateFrom: String? = nil, idle: Bool = false, busy: Bool = false, starting: Bool = false) -> Screen {
        // The lowest version first, above the reminder's note too.
        var warnings: [Notice] = []
        if let updateFrom {
            warnings.append(Notice(text: copy("app_before.update_soon", ["min_app_from": updateFrom, "store": Self.store]), button: update))
        }
        if idle { warnings.append(Notice(text: copy("app_before.idle"), button: nil)) }
        // No platform table yet: by the platforms the app has its own definition of.
        var blocks: [Block] = [
            .title(copy("before.title")),
            .text(copy("before.prepare_card")),
            .text(copy("before.citizens_only")),
        ]
        // One platform: what the proof says and that it is public is step 5's to say.
        if Platform.known.count != 1 {
            blocks += [.text(copy("before.one_proof")), .strong(copy("before.listed_together"))]
        }
        // Under common.next, as on the web and Android (card-proof.md, step 1): they can be skipped.
        let questions: [Block] = [
            .question(copy("before.why_physical"), [.text(copy("before.why_physical_card")), .text(copy("before.why_physical_mobile"))]),
            // The two ways out of the card proof's screens: a person without a card cannot go on (card-proof.md, step 1).
            .question(copy("before.how_to_get"), [
                .text(copy("before.how_to_get_counter")),
                .button(Button(label: copy("before.find_office"), action: .findOffice), main: false),
                .action(Button(label: copy("before.how_to_get_moica"), action: .howToApply)),
            ]),
        ]
        if paused { return Screen(step: 1, blocks: blocks + [.message(copy("before.paused"))] + questions, warnings: warnings, notice: notice, settings: settingsButton) }
        if busy { blocks.append(.message(copy("before.busy"))) }
        return Screen(step: 1, blocks: blocks, buttons: [Button(label: copy("common.next"), action: .start, enabled: !starting)], under: questions, warnings: warnings, notice: notice, settings: settingsButton)
    }

    private var settingsButton: Button { Button(label: appCopy("settings.open"), action: .openSettings) }

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
    /// why it stopped at the next one. `demoPlaying`: the demonstration of
    /// where the card goes is playing; `demoPlayed`: it has played since
    /// the step came up.
    func read(reached: Int, running: Bool, stop: Flow.Stop?, demoPlaying: Bool = false, demoPlayed: Bool = false) -> Screen {
        let labels = [copy("read.server"), copy("app_read.certificate"), copy("read.check"), copy("read.crl")]
        let done = reached == labels.count
        let spot = copy("app_read.spot_iphone")
        var blocks: [Block] = [
            .title(copy("read.title")),
            .text(done ? copy("app_read.lift") : copy("app_read.how", ["spot": spot])),
        ]
        // Where the card goes, until it is read; the system's panel covers it while it is, and it does
        // not play then: its button waits for the tap to end.
        if !done {
            let playing = demoPlaying && !running
            var control = playing
                ? Button(label: copy("app_demo.stop"), action: .stopDemo)
                : Button(label: copy("app_demo.replay"), action: .playDemo)
            control.enabled = !running
            blocks.append(.senseDemo(SenseDemo(
                description: copy("app_demo.sense_iphone"), control: control, playing: playing, played: playing || demoPlayed || running)))
        }
        let list = Block.items(items(labels, reached: reached, running: running, why: stop.map { message($0, tap: 1) }))
        // Once the list has something to say (all done, where it stopped and why), it is read before the button.
        if done { return Screen(step: 2, blocks: blocks + [list], buttons: [Button(label: copy("common.next"), action: .toPIN)]) }
        if let stop {
            // No card came, or it left: the same tap again. Anything else: the card is read again from the start.
            let again = Self.tapsAgain(stop)
            let button = again ? Button(label: copy("app_read.tap_again"), action: .readCard) : Button(label: copy("app_read.restart"), action: .readAgain)
            return Screen(step: 2, blocks: blocks + [list], buttons: [button])
        }
        // Before, "感應卡片" right under the demonstration, where it is seen without scrolling, and the list, all still
        // to do, under it (card-proof.md, "2. 讀取卡片", app).
        return Screen(
            step: 2, blocks: blocks,
            buttons: [Button(label: copy("common.back"), action: .back, enabled: !running), Button(label: copy("app_read.tap_card"), action: .readCard, enabled: !running)],
            under: [list])
    }

    // Step 3: the PIN ------------------------------------------------------------------

    enum PINState: Equatable {
        /// Waiting for the PIN, with what went wrong the last time, if anything.
        case waiting(String?)
        /// Tap 2 is under way.
        case tapping
        /// The card signed; the card's state is being asked for.
        case signed
        /// The tap ended and the PIN is kept (another card than the one read, no card, the card left before
        /// the PIN went or after it was accepted): why, and the same tap again.
        case tapAgain(String)
        /// The card signed and the server turned its state away as too many: why, and the same request again.
        case retry([String])
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
        case .tapAgain(let message):
            blocks.append(.message(message))
            buttons = [Button(label: copy("app_read.tap_again"), action: .confirmCard)]
        case .retry(let why):
            // Asked again, the card not tapped again; 上一步 reads the card again (card-proof.md, step 3).
            blocks += why.map(Block.message)
            buttons = [Button(label: copy("common.back"), action: .back), Button(label: copy("progress.retry"), action: .retryCardState)]
        case .stopped(let why):
            blocks += why.map(Block.message)
            buttons = [Button(label: copy("app_read.restart"), action: .readAgain)]
        }
        blocks.append(.points([copy("pin.purpose"), copy("app_pin.stays")]))
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
        if row.switchesLeft == 0 {
            lines.append(row.current != nil ? copy("accounts.row_can_clear") : copy("accounts.row_only_back", ["last_declared": last]))
        }
        return lines
    }

    /// Which of step 4's screens is up.
    enum AccountsMode: Equatable {
        /// As the step opens: the rows to fill when the card declares
        /// nothing; what it declares and what can be done when it does.
        case open
        /// After "改成別的帳號" (one platform): a field for another account.
        case switching
        /// After "修改帳號清單" (more than one platform): a row for each.
        case editing
    }

    /// The card's list as it is: for each platform the screens offer, its account now, or "".
    static func listNow(_ status: Flow.CardStatus) -> [String: String] {
        Dictionary(status.rows.filter(\.known).map { ($0.platform, $0.current ?? "") }, uniquingKeysWith: { first, _ in first })
    }

    private func accountsTitle(_ single: String?) -> Block {
        .title(single.map { copy("accounts.title_single", ["platform": $0]) } ?? copy("accounts.title"))
    }

    /// A row with a field for each platform the app knows; the row as it
    /// is for an account on a platform it does not know. `lines`: whether
    /// a row says its counts.
    private func fields(_ status: Flow.CardStatus, typed: [String: String], errors: [String: String], lines: Bool) -> [Block] {
        status.rows.map { row -> Block in
            guard row.known, let platform = Platform.of(row.platform) else {
                // Shown as the server sent it; kept in the list as it is.
                return .row(name: row.platform, account: row.current ?? "", lines: rowLines(row))
            }
            return field(row, platform, typed: typed, errors: errors, lines: lines ? rowLines(row) : [])
        }
    }

    /// A row with a field, and beside it the preview of the account typed.
    private func field(_ row: Flow.StatusRow, _ platform: Platform, typed: [String: String], errors: [String: String], lines: [String]) -> Block {
        .account(AccountRow(
            platform: row.platform,
            name: platform.name,
            prefix: platform.prefix,
            text: typed[row.platform] ?? "",
            preview: Button(label: copy("app_accounts.preview"), action: .preview(row.platform)),
            lines: lines,
            error: errors[row.platform]))
    }

    /// The sentence under the fields about the preview, naming the
    /// platform (the app knows Threads alone). With the switches a typo
    /// costs, unless the screen already says how many are left
    /// (`counted`; card-proof.md, step 4).
    private func previewNote(_ single: String?, counted: Bool) -> [Block] {
        guard let name = single ?? Platform.known.first?.name else { return [] }
        return [.text(copy(counted ? "accounts.preview_note_single_counted" : "accounts.preview_note_single", ["platform": name]))]
    }

    private var cancel: Button { Button(label: copy("common.cancel"), action: .restart) }
    private var keep: Button { Button(label: copy("accounts.keep"), action: .keep) }

    /// Step 4 (design/copy/card-proof.md, step 4, and its "app"), by what
    /// the card declares and by `mode`; the same choices as accountsView,
    /// switchView and editListView of web/src/ui/messages.ts. `typed`: what
    /// each field holds; `errors`: what is wrong with a row, by platform;
    /// `message`: what is wrong with the whole list.
    func accounts(_ status: Flow.CardStatus, mode: AccountsMode = .open, typed: [String: String], errors: [String: String], message: String?) -> Screen {
        let declared = status.rows.contains { $0.current != nil }
        guard declared else { return fill(status, typed: typed, errors: errors, message: message) }
        // No field to write it under: what is wrong with a row is said as what is wrong with the list.
        let whole = message ?? errors.keys.sorted().first.flatMap { errors[$0] }
        // 3 records today: what the card declares, and the way back to the start.
        if status.dailyLimit { return declaredNow(status, message: whole) }
        switch mode {
        case .open: return declaredNow(status, message: whole)
        case .switching: return switching(status, typed: typed, errors: errors, message: message)
        case .editing: return editing(status, typed: typed, errors: errors, message: message)
        }
    }

    /// The card declares nothing: a row to fill for each platform.
    private func fill(_ status: Flow.CardStatus, typed: [String: String], errors: [String: String], message: String?) -> Screen {
        let single = Self.onePlatform(status)
        let never = status.lastCardProof == nil
        var blocks: [Block] = [
            accountsTitle(single),
            .text(never ? copy("accounts.none_yet") : copy("accounts.nothing_now")),
            .text(single.map { copy("accounts.fill_one_single", ["platform": $0]) } ?? copy("accounts.fill_one")),
        ]
        if status.dailyLimit {
            // The rows as they are, without a field.
            blocks += status.rows.map { row in
                Block.row(name: row.known ? Platform.of(row.platform)?.name ?? row.platform : row.platform, account: "", lines: [])
            }
            if let message { blocks.append(.message(message)) }
            return dailyLimit(status, blocks)
        }
        // One platform: no line under a row never declared, and no rules of switching.
        blocks += fields(status, typed: typed, errors: errors, lines: single == nil || !never)
        if let message { blocks.append(.message(message)) }
        if single == nil {
            blocks.append(.text((never ? copy("accounts.one_per_platform") : copy("accounts.how_change")) + copy("accounts.switches_limited")))
        }
        // A row never declared on one platform says no count: the full sentence.
        blocks += previewNote(single, counted: single == nil || !never)
        return Screen(step: 4, blocks: blocks, buttons: [Button(label: copy("common.next"), action: .toConfirm)], cancel: cancel)
    }

    /// The card declares accounts: which, when it last did, "更新島民證明",
    /// and under it the other things that can be done.
    private func declaredNow(_ status: Flow.CardStatus, message: String?) -> Screen {
        let single = Self.onePlatform(status)
        var blocks: [Block] = [accountsTitle(single), .text(copy("accounts.declared_now"))]
        let current = status.rows.filter { $0.current != nil }
        if single != nil {
            blocks += current.map { Block.declared(Platform.handle($0.platform, $0.current ?? "")) }
        } else {
            blocks += current.map { row in
                row.known
                    ? Block.row(name: Platform.of(row.platform)?.name ?? row.platform, account: Platform.handle(row.platform, row.current ?? ""), lines: [])
                    : Block.row(name: row.platform, account: row.current ?? "", lines: [copy("accounts.row_unknown_platform")])
            }
        }
        if let days = status.daysSince {
            blocks.append(.text(days <= 0 ? copy("accounts.last_proof_today") : copy("accounts.last_proof", ["days_ago": String(days)])))
        }
        if let message { blocks.append(.message(message)) }
        if status.dailyLimit { return dailyLimit(status, blocks) }
        blocks += [
            .button(Button(label: copy("accounts.refresh"), action: .refresh), main: true),
            .small(copy("accounts.refresh_note")),
        ]
        if single != nil, let only = current.first {
            blocks += [
                .action(Button(label: copy("accounts.switch"), action: .toSwitch)),
                .action(Button(label: copy("accounts.withdraw", ["account": Platform.handle(only.platform, only.current ?? "")]), action: .withdraw)),
            ]
        } else {
            blocks.append(.action(Button(label: copy("accounts.edit_list"), action: .editList)))
        }
        return Screen(step: 4, blocks: blocks, cancel: cancel)
    }

    /// 3 records of the card today (card-proof.md, 今天已經過卡 3 次): under
    /// what the card declares, the sentence and the card's page; 重新掛上連結
    /// where the card declares an account the app can hang, and 回到開頭.
    /// Neither is the main button: the card proof goes no further today.
    private func dailyLimit(_ status: Flow.CardStatus, _ blocks: [Block]) -> Screen {
        let rehang = Self.hangable(status).isEmpty ? [] : [Button(label: copy("hang.rehang"), action: .hangFromLimit)]
        return Screen(
            step: 4, blocks: blocks + [.text(copy("stops.daily_limit")), openingTheProof("hang.look")],
            buttons: rehang + [Button(label: copy("accounts.restart"), action: .restart)], mainButton: false)
    }

    /// The accounts the card declares now on platforms the app knows: those a link can be hung for.
    static func hangable(_ status: Flow.CardStatus) -> [Flow.Account] {
        status.rows.compactMap { row in
            guard row.known, Platform.of(row.platform) != nil, let current = row.current else { return nil }
            return Flow.Account(platform: row.platform, username: current)
        }
    }

    /// 重新掛上連結 of 3 records today: the whole of step 6 for the
    /// accounts the card declares now (card-proof.md, 今天已經過卡 3 次,
    /// app). Out of the eight steps, and no record this time: no date, no
    /// notes of one. 上一步 back to step 4, 回到開頭 to step 1. `copied`,
    /// `demoPlaying`, `demoPlayed` as for step 6.
    func hangFromLimit(_ status: Flow.CardStatus, copied: Bool, demoPlaying: Bool = false, demoPlayed: Bool = false) -> Screen {
        let blocks = hangWhole(Self.hangable(status), shortID: status.shortID, single: Self.onePlatform(status), copied: copied, demoPlaying: demoPlaying, demoPlayed: demoPlayed)
            + hungYet
        return Screen(
            step: 4, inSteps: false, blocks: blocks,
            buttons: [Button(label: copy("common.back"), action: .back), Button(label: copy("accounts.restart"), action: .restart)],
            mainButton: false)
    }

    /// After "改成別的帳號": the account now, a field for another, what
    /// changing it does and what it costs. No field when no switch is left.
    private func switching(_ status: Flow.CardStatus, typed: [String: String], errors: [String: String], message: String?) -> Screen {
        let single = Self.onePlatform(status)
        guard let row = status.rows.first(where: { $0.known && $0.current != nil }), let platform = Platform.of(row.platform) else {
            return declaredNow(status, message: message)
        }
        let now = Platform.handle(row.platform, row.current ?? "")
        var blocks: [Block] = [accountsTitle(single), .text(copy("accounts.declared_inline", ["account": now]))]
        // Used up: no other account can be declared.
        if row.switchesLeft == 0 {
            blocks.append(.text(copy("accounts.row_used_up", ["switches_used": String(row.switchCount)])))
            if let whole = message ?? errors[row.platform] { blocks.append(.message(whole)) }
            return Screen(step: 4, blocks: blocks, links: [keep], cancel: cancel)
        }
        let cost = row.switchesLeft == 1
            ? copy("confirm.uses_final_switch")
            : copy("accounts.switch_limit", ["switches_left": String(row.switchesLeft - 1)])
        blocks += [
            .subheading(copy("accounts.switch")),
            field(row, platform, typed: typed, errors: errors, lines: []),
        ]
        if let message { blocks.append(.message(message)) }
        blocks.append(.sentences([copy("accounts.switch_effect", ["account": now]), cost]))
        blocks += previewNote(single, counted: true)
        return Screen(step: 4, blocks: blocks, buttons: [Button(label: copy("common.next"), action: .toConfirm)], links: [keep], cancel: cancel)
    }

    /// After "修改帳號清單": a row for each platform, each changed on its own.
    private func editing(_ status: Flow.CardStatus, typed: [String: String], errors: [String: String], message: String?) -> Screen {
        let single = Self.onePlatform(status)
        var blocks: [Block] = [accountsTitle(single), .text(copy("accounts.current"))]
        blocks += fields(status, typed: typed, errors: errors, lines: true)
        if let message { blocks.append(.message(message)) }
        blocks.append(.text(copy("accounts.how_change") + copy("accounts.switches_limited")))
        blocks += previewNote(single, counted: true)
        return Screen(step: 4, blocks: blocks, buttons: [Button(label: copy("common.next"), action: .toConfirm)], links: [keep], cancel: cancel)
    }

    // Step 5: confirming ----------------------------------------------------------------------

    /// What a row does (step 5, the table of what each row does), and for a
    /// switch what it uses up.
    func rowSentences(_ row: Flow.ConsequenceRow) -> [String] {
        var lines: [String]
        switch row.kind {
        case "first": lines = [copy("kinds.first")]
        case "refresh": lines = [row.current == row.username ? copy("kinds.unchanged") : copy("kinds.again")]
        case "withdraw": lines = [copy("kinds.withdraw")]
        default: lines = [copy("kinds.switch", ["previous": Platform.handle(row.platform, row.previous ?? "")])]
        }
        if row.kind == "switch" {
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

    /// Step 5 (design/copy/card-proof.md, step 5); the same choices as
    /// confirmView of web/src/ui/messages.ts.
    func confirm(_ status: Flow.CardStatus, _ consequence: Flow.Consequence) -> Screen {
        let single = Self.onePlatform(status)
        let empty = consequence.accounts.isEmpty
        var blocks: [Block] = [
            .title(copy("confirm.title")),
            .text(empty ? copy("confirm.intro_withdraw_all") : single != nil ? copy("confirm.intro_public") : copy("confirm.intro")),
        ]
        blocks += consequence.rows.map { row($0, lines: rowSentences($0)) }
        blocks += [
            .pair(copy("confirm.date"), consequence.today),
            .pair(copy("confirm.short_id_label"), copy("confirm.short_id", ["short_id": status.shortID])),
        ]
        if !empty, single == nil {
            if consequence.rows.contains(where: { $0.kind == "withdraw" }) { blocks.append(.text(copy("confirm.withdraw_stays"))) }
            blocks.append(.lead(copy("confirm.listed_together")))
        }
        // The points name the platforms of the screens: the one, or each the app knows of the server's table.
        let named = single ?? status.knownPlatforms.map { Platform.of($0)?.name ?? $0 }.joined(separator: copy("confirm.platform_separator"))
        let notIdentifiable = copy("confirm.not_identifiable", ["platform": named])
        if empty {
            blocks.append(.points([copy("confirm.history_stays"), notIdentifiable, copy("confirm.holder_later_withdraw")]))
        } else {
            // "所有紀錄公開後無法刪除" in ink and bold: red is for the way on, not for a warning (card-proof.md, step 5).
            let cannotDelete = copy("confirm.cannot_delete")
            blocks.append(.points([notIdentifiable, copy("confirm.holder_later", ["platform": named, "cannot_delete": cannotDelete])], bold: cannotDelete))
        }
        let button: String
        if empty {
            if single != nil, consequence.rows.count == 1, let only = consequence.rows.first {
                button = copy("confirm.button_withdraw", ["account": Platform.handle(only.platform, only.username)])
            } else {
                button = copy("confirm.button_withdraw_all")
            }
        } else if Self.allUnchanged(consequence.rows) {
            button = copy("confirm.button_refresh")
        } else {
            button = single != nil ? copy("confirm.button_declare_single") : copy("confirm.button_declare")
        }
        return Screen(
            step: 5, blocks: blocks,
            buttons: [Button(label: copy("common.back"), action: .back), Button(label: button, action: .declare)],
            cancel: cancel)
    }

    /// Step 5 once the button was pressed. `reached`: how many items are
    /// done (0 to 4); `stop`: why it stopped at the next one, and whether
    /// the record can be sent again as it is.
    func progress(reached: Int, stop: Flow.Stop?, submitFailed: Bool = false) -> Screen {
        // The seconds are the copy's figure for an iPhone (card-proof.md, step 5, "app").
        let labels = [copy("progress.server"), copy("app_progress.sign"), copy("app_progress.compute", ["seconds": "5"]), copy("progress.submit")]
        var blocks: [Block] = [.title(copy("progress.title")), .text(copy("app_progress.keep_open"))]
        // The card signed: it can be taken away.
        if reached >= 2 { blocks.append(.strong(copy("app_read.lift"))) }
        let why = stop.map { submitFailed && !$0.tooMany ? [copy("stops.submit_failed")] : message($0, tap: 3) }
        blocks.append(.items(items(labels, reached: reached, running: stop == nil, why: why)))
        guard let stop else { return Screen(step: 5, blocks: blocks) }
        if Self.tapsAgain(stop) {
            // The PIN is still there: only this tap again.
            return Screen(
                step: 5, blocks: blocks,
                buttons: [Button(label: copy("app_read.tap_again"), action: .signAgain)],
                cancel: cancel)
        }
        if stop.tooMany {
            // Too many people: the challenge asked for again (then tap 3), or the record sent again; the card is not read again.
            return Screen(
                step: 5, blocks: blocks,
                buttons: [Button(label: copy("progress.retry"), action: submitFailed ? .submitAgain : .declare)],
                cancel: cancel)
        }
        // The PIN is gone, and the phone could not talk to the card: back to the start. So when the server takes no card
        // proof for now (docs/api/card-proof.md, `paused`): the same record would be refused again.
        if stop == .card(.channel) || Self.isPaused(stop) {
            return Screen(step: 5, blocks: blocks, buttons: [Button(label: copy("accounts.restart"), action: .restart)])
        }
        var buttons = [Button(label: copy("app_read.restart"), action: .readAgain)]
        if submitFailed { buttons.append(Button(label: copy("progress.retry"), action: .submitAgain)) }
        return Screen(step: 5, blocks: blocks, buttons: buttons)
    }

    // After the record was sent: steps 6 to 8 ------------------------------------------------

    /// What the server says was recorded changes nothing: a card proof again.
    private func recordedUnchanged(_ done: Flow.Done) -> Bool {
        guard let kinds = done.answer.kinds else { return false }
        let current = Dictionary(done.expected.map { ($0.platform, $0.current) }, uniquingKeysWith: { first, _ in first })
        return kinds.allSatisfy { $0.kind == "refresh" && current[$0.platform] == .some($0.username) }
    }

    /// The title of the last step (card-proof.md, step 8, the table of
    /// titles), by what the server says was recorded; the same choices as
    /// doneTitle of web/src/ui/messages.ts. With one platform a new
    /// declaration, or one again after a withdrawal, is congratulated like
    /// a first one, and a switch names the account it is now.
    private func finishTitle(_ done: Flow.Done, single: String?) -> String {
        guard let kinds = done.answer.kinds else { return copy("done.recorded_only") }
        if done.firstRecord { return copy("finish.first") }
        if done.accounts.isEmpty { return copy("done.withdraw_all") }
        if recordedUnchanged(done) { return copy("done.refresh") }
        if single != nil, kinds.count == 1, let kind = kinds.first {
            let before = done.expected.first { $0.platform == kind.platform }?.current
            if kind.kind == "first" || (kind.kind == "refresh" && before == nil) { return copy("finish.first") }
            if kind.kind == "switch" {
                return copy("finish.switched", ["account": Platform.handle(kind.platform, kind.username)])
            }
        }
        return copy("done.changed")
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
            if !(kind.kind == "switch" && previous == nil) {
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

    /// What the proof log recorded, shown only where it is not what step 5
    /// said (card-proof.md, step 6, the record that differs): under the
    /// whole of step 6, or on the last step when everything was withdrawn.
    private func record(_ done: Flow.Done, single: String?) -> [Block] {
        guard let kinds = done.answer.kinds, !done.answer.mismatches.isEmpty else { return [] }
        let first = done.accounts.isEmpty ? copy("done.record_withdraw_all") : single != nil ? copy("done.record_single") : copy("done.record_list")
        return [.heading(copy("done.recorded")), .text(done.date), .text(first)]
            + recordedRows(done, kinds: kinds)
            + [.text(copy("done.short_id", ["short_id": done.shortID]))]
    }

    /// What every screen after the record was sent starts with: that what
    /// was recorded differs from step 5, when it does.
    private func mismatch(_ done: Flow.Done) -> [Block] {
        done.answer.mismatches.isEmpty ? [] : [.message(copy("done.mismatch"))]
    }

    /// A sentence of the copy with the link to the card's page in the place of `{open_proof}`.
    private func openingTheProof(_ key: String) -> Block {
        let parts = copy(key).components(separatedBy: "{open_proof}")
        return .linked(parts.first ?? "", Button(label: copy("done.open_proof"), action: .openProof), parts.dropFirst().first ?? "")
    }

    /// Step 6 asks only whether the link is still there (card-proof.md,
    /// step 6, the short one): a card proof again, with one platform,
    /// recorded as step 5 said.
    func hangIsShort(_ done: Flow.Done, single: String?) -> Bool {
        single != nil && !done.accounts.isEmpty && !done.firstRecord && done.answer.mismatches.isEmpty && recordedUnchanged(done)
    }

    /// Step 6: the link to the card's page, to put on the profile
    /// (card-proof.md, step 6 and its "app"). `single`: the one platform's
    /// name, as step 5 decided it. `copied`: the link was copied. `whole`:
    /// the whole step also where the short one would do ("重新掛上連結"
    /// was pressed), with 上一步 back to the short one. The same parts as the web page's, but for
    /// what only the page has: the QR code, and "現在可以拔出卡片。" (the
    /// panel said the card can be taken away when it signed). In the
    /// order of the page a phone opens to hang it: the link, the two
    /// buttons side by side, the demonstration, the four steps.
    /// `demoPlaying`: the demonstration is playing; `demoPlayed`: it has
    /// played in this card proof.
    func hang(_ done: Flow.Done, single: String?, copied: Bool, whole: Bool = false, demoPlaying: Bool = false, demoPlayed: Bool = false) -> Screen {
        let kinds = done.answer.kinds
        let link = Block.link(address(done.shortID))
        var blocks = mismatch(done)
        blocks.append(.text(copy("done.recorded_on", ["date": done.date])))
        if kinds == nil { blocks.append(.text(copy("done.kinds_unreadable"))) }
        if !whole, hangIsShort(done, single: single), let single {
            blocks += [
                .title(copy("hang.still_there_single", ["platform": single])),
                link,
                openingTheProof("hang.look"),
                .text(copy("hang.why_single")),
            ]
            return Screen(
                step: 6, blocks: blocks,
                buttons: [Button(label: copy("hang.rehang"), action: .rehang), Button(label: copy("common.next"), action: .toRemind)])
        }
        blocks += hangWhole(done.accounts, shortID: done.shortID, single: single, copied: copied, demoPlaying: demoPlaying, demoPlayed: demoPlayed)
        // A new card's new link, a withdrawn account's link, the other cards that declare an account.
        if done.firstRecord { blocks.append(.small(copy("hang.new_card"))) }
        let withdrew = kinds.map { $0.contains { $0.kind == "withdraw" } } ?? done.expected.contains { $0.kind == "withdraw" }
        if withdrew { blocks.append(.small(copy("done.withdrawn_link"))) }
        blocks += (kinds ?? []).filter { $0.kind != "withdraw" && ($0.accountCards ?? 0) > 1 }.map { kind in
            let account = (done.expected.first { $0.platform == kind.platform }?.known ?? (Platform.of(kind.platform) != nil))
                ? Platform.handle(kind.platform, kind.username) : kind.username
            return Block.small(copy("done.other_cards", ["account": account]))
        }
        blocks += hungYet
        blocks += record(done, single: single)
        // Reached from the short one by "重新掛上連結": back to it, beside the way on (card-proof.md, step 6, the short one).
        let back = whole && hangIsShort(done, single: single) ? [Button(label: copy("common.back"), action: .back)] : []
        // One main button a screen (design/DESIGN.md): copying the link, here.
        return Screen(step: 6, blocks: blocks, buttons: back + [Button(label: copy("common.next"), action: .toRemind)], mainButton: false)
    }

    /// The card's page, as the screens write it: without the scheme.
    private func address(_ shortID: String) -> String { "\(host)/p/\(shortID)" }

    /// How to tell the link is on the profile: under the whole of step 6.
    private var hungYet: [Block] { [openingTheProof("done.hung"), .text(copy("done.hung_done"))] }

    /// The whole of step 6 from its title to its four steps, for
    /// `accounts` on platforms the app knows and the card's page
    /// (card-proof.md, step 6, app): the title, why, the link, copying it
    /// and beside it the public page of each account, the demonstration,
    /// the four steps. Step 6's, and 重新掛上連結's of step 4 on a day
    /// with 3 records.
    private func hangWhole(_ accounts: [Flow.Account], shortID: String, single: String?, copied: Bool, demoPlaying: Bool, demoPlayed: Bool) -> [Block] {
        var blocks: [Block] = [
            .title(single.map { copy("hang.title_single", ["platform": $0]) } ?? copy("hang.title")),
            .text(single != nil ? copy("hang.why_single") : copy("done.anyone")),
            .link(address(shortID)),
        ]
        // Copying the link, and beside it the public page of each account of the card on a platform the app
        // knows: the order of the demonstration's first screen, which is this one.
        let profiles = accounts.compactMap { account in
            Platform.of(account.platform).map { platform in
                // The short words, so that the two fit side by side; VoiceOver reads whose profile it opens.
                Button(
                    label: copy("hang.open_threads", ["platform": platform.name]),
                    action: .openProfile(account.platform),
                    spoken: copy("done.open_profile", ["account": Platform.handle(account.platform, account.username), "platform": platform.name]))
            }
        }
        blocks.append(.sideBySide([Button(label: copied ? copy("done.copied") : copy("hang.copy"), action: .copyLink)] + profiles))
        if let demo = hangDemo(accounts, shortID: shortID, playing: demoPlaying, played: demoPlayed) { blocks.append(.demo(demo)) }
        blocks.append(.steps([copy("done.step_edit"), copy("done.step_link"), copy("done.step_add"), copy("done.step_paste")]))
        return blocks
    }

    /// The demonstration of hanging the link, for the card's account on
    /// Threads (card-proof.md, the demonstrations); none for a card
    /// without one. Its first screen is this step's own, with this step's
    /// words; the other four are the sketches of Threads.
    func hangDemo(_ done: Flow.Done, playing: Bool, played: Bool = false) -> HangDemo? {
        hangDemo(done.accounts, shortID: done.shortID, playing: playing, played: played)
    }

    private func hangDemo(_ accounts: [Flow.Account], shortID: String, playing: Bool, played: Bool) -> HangDemo? {
        let threads = Platform.threads
        guard let account = accounts.first(where: { $0.platform == threads.id }) else { return nil }
        let handle = Platform.handle(threads.id, account.username)
        let link = address(shortID)
        let words = HangDemo.Words(
            title: copy("hang.title_single", ["platform": threads.name]),
            copy: copy("hang.copy"),
            copied: copy("done.copied"),
            open: copy("hang.open_threads", ["platform": threads.name]),
            edit: copy("app_demo_hang.edit"),
            found: copy("app_demo_hang.found"),
            rows: [copy("app_demo_hang.row_name"), copy("app_demo_hang.row_username"), copy("app_demo_hang.row_bio"), copy("app_demo_hang.row_interests")],
            links: copy("app_demo_hang.row_links"),
            featured: copy("app_demo_hang.row_featured"),
            add: copy("app_demo_hang.add"),
            done: copy("app_demo_hang.done"),
            url: copy("app_demo_hang.url"),
            paste: copy("app_demo_hang.paste"),
            linkTitle: copy("app_demo_hang.link_title"))
        return HangDemo(
            description: copy("app_demo.hang"),
            control: playing
                ? Button(label: copy("app_demo.stop"), action: .stopDemo)
                : Button(label: copy("app_demo.replay"), action: .playDemo),
            playing: playing,
            played: playing || played,
            account: handle,
            link: link,
            address: "https://" + link,
            words: words)
    }

    /// Step 7: the reminder to come back (card-proof.md, step 7), by what
    /// the phone keeps. `notAfter`: the end of the card's certificate,
    /// YYMMDDHHMMSS, compared in memory with the reminder's day.
    func remind(_ reminder: DoneReminder, notAfter: String?) -> Screen {
        var blocks: [Block] = [.title(copy("app_done.reminder_title"))]
        let back = Button(label: copy("common.back"), action: .back)
        let adjust = Button(label: copy("app_reminder.adjust"), action: .adjustReminder)
        let skip = Button(label: copy("app_reminder.skip"), action: .toFinish)
        let settings: ReminderSettings
        let counted: Bool
        switch reminder {
        case .ask(let asked):
            settings = asked
            counted = true
        case .on(let kept, let fromToday):
            settings = kept
            counted = fromToday
        }
        let when = When(appCopy: appCopy)
        let values = ["day": when.day(settings.next), "time": when.time(settings.time), "interval": when.interval(settings.interval)]
        blocks += [
            .text(copy("app_reminder.why")),
            .text(counted ? copy("app_done.reminder_next_about", values) : copy("app_done.reminder_next", values)),
        ]
        // The certificate ends before the reminder comes.
        if let validUntil = notAfter.flatMap(Self.dateOfCertificateTime), validUntil < settings.next.iso {
            blocks.append(.text(copy("app_done.reminder_expires", ["valid_until": validUntil])))
        }
        // Nothing kept: "設定提醒" opens the screen to choose the interval and time, where "開啟提醒" asks the system
        // and sets it; back here it is on, and 下一步 is the cardholder's to press (card-proof.md, step 7).
        if case .ask = reminder {
            return Screen(
                step: 7, blocks: blocks,
                buttons: [back, Button(label: copy("app_done.reminder_set"), action: .adjustReminder)],
                links: [skip])
        }
        // On already: turned off from the settings, not here.
        return Screen(step: 7, blocks: blocks, buttons: [back, Button(label: copy("common.next"), action: .toFinish)], links: [adjust])
    }

    /// What the share sheet gets before the card's address, on the line
    /// above it: the sentence with the card's ordinal, written as the
    /// card's page writes it, or without a number when the answer had none
    /// (design/copy/card-proof.md, step 8).
    func shareText(_ done: Flow.Done) -> String {
        guard let ordinal = done.answer.ordinal else { return copy("done.share_text_unnumbered") }
        return copy("done.share_text", ["ordinal": Self.thousands(ordinal)])
    }

    /// A whole number with a comma between groups of three digits.
    private static func thousands(_ n: Int) -> String {
        let digits = String(n)
        return digits.enumerated().map { i, c in (i > 0 && (digits.count - i) % 3 == 0 ? "," : "") + String(c) }.joined()
    }

    /// Step 8: done, and the invitation to share (card-proof.md, step 8
    /// and its "app"). When every account was withdrawn it follows step 5:
    /// no card, nothing to hang, to be reminded of or to share.
    func finish(_ done: Flow.Done, single: String?) -> Screen {
        let end = Button(label: copy("finish.done"), action: .restart)
        guard !done.accounts.isEmpty else {
            var blocks = mismatch(done)
            blocks += [.title(finishTitle(done, single: single)), .text(copy("done.recorded_on", ["date": done.date]))]
            if done.answer.kinds == nil { blocks.append(.text(copy("done.kinds_unreadable"))) }
            blocks.append(.text(single.map { copy("finish.unlink_single", ["platform": $0]) } ?? copy("done.withdrawn_link")))
            blocks += record(done, single: single)
            return Screen(step: 8, blocks: blocks, buttons: [end], settings: settingsButton)
        }
        let card = ProofCard(
            label: copy("done.proof"),
            rows: done.accounts.map { account in
                ProofCard.Row(name: single != nil ? nil : Platform.of(account.platform)?.name ?? account.platform, account: Platform.handle(account.platform, account.username))
            },
            shortID: copy("confirm.short_id_label") + " " + copy("confirm.short_id", ["short_id": done.shortID]))
        // The card's ordinal, when the answer had one, before the invitation.
        let ordinal = done.answer.ordinal.map { [copy("finish.ordinal", ["ordinal": Self.thousands($0)])] } ?? []
        var blocks: [Block] = [
            .title(finishTitle(done, single: single)),
            .proofCard(card),
            // The thanks is in the ordinal's sentence; without an ordinal, on its own (card-proof.md, step 8).
            .sentences((ordinal.isEmpty ? [copy("finish.thanks")] : ordinal) + [copy("finish.invite")]),
        ]
        // The main button on top: the composer of the platform the app knows, with the share sheet beside it as a
        // small button of the system's symbol; 上一步 and 完成 side by side under them (design/DESIGN.md, the
        // components: buttons).
        let share = Platform.known.first.map { Button(label: copy("done.share", ["platform": $0.name]), action: .shareOn($0.id)) }
        return Screen(
            step: 8, blocks: blocks,
            buttons: [Button(label: copy("common.back"), action: .back), end], top: share,
            beside: Button(label: copy("app_done.share_other"), action: .share),
            mainButton: false, settings: settingsButton)
    }

    /// The tap ended in a way that leaves it to be made again as it is:
    /// no card came or the panel was closed, another card than the one
    /// read, the card left.
    static func tapsAgain(_ stop: Flow.Stop) -> Bool {
        switch stop {
        case .card(.noTap), .card(.cancelled), .card(.otherCard), .card(.dropped): return true
        default: return false
        }
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
        case .card(.locked): return [copy("stops.card_locked")]
        case .card(.channel): return [copy("app_stops.channel")]
        case .card(.firstGeneration): return [copy("app_stops.first_generation")]
        // The card left: in tap 1 nothing is lost. In tap 2 the PIN is kept, but for a PIN that went to the card
        // and was never accepted: that one is typed again. In tap 3 the card has accepted it before (#133).
        case .card(.dropped(let pin)):
            switch tap {
            case 1: return [copy("app_stops.read_dropped")]
            case 2: return [pin == .sent ? copy("app_stops.pin_maybe_received") : copy("app_stops.dropped_pin_kept")]
            default: return [copy("app_stops.dropped")]
            }
        // The panel closed by the cardholder: said only where the card would have signed the declaration.
        case .card(.cancelled): return tap == 3 ? [copy("app_stops.tap_cancelled")] : []
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
        case .state: return ["state"]
        case .server(let failure):
            let requestID = failure.requestID.map { [copy("stops.request_id", ["request_id": $0])] } ?? []
            // Too many people (429, or 503 `busy`; ADR-0026): the same request can be sent again, the card not tapped again.
            if failure.tooMany { return [copy("stops.too_many")] + requestID }
            let sentence: String
            switch failure.code {
            case "challenge_unknown": sentence = copy("stops.challenge_expired")
            case "crl_stale": sentence = copy("stops.server_crl_stale")
            case "daily_limit": sentence = copy("stops.daily_limit")
            // The server takes no card proof for now (docs/api/card-proof.md, `paused`): not a failure to send again.
            case "paused": sentence = copy("stops.paused")
            case "switch_limit": sentence = copy("stops.switch_limit")
            case "empty": sentence = copy("stops.empty")
            case "scope", "platform", "malformed", "challenge_used", "challenge_attempts", "proof", "root", "date_order":
                sentence = copy("stops.rejected", ["code": failure.code])
            default: sentence = copy("stops.server_unreadable", ["code": failure.code])
            }
            return [sentence] + requestID
        }
    }

    private static func isPaused(_ stop: Flow.Stop) -> Bool {
        if case .server(let failure) = stop { return failure.code == "paused" }
        return false
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
