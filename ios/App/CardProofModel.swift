import Foundation

/// The card proof as the screens see it: which screen is up, what it says
/// (`screen`), and what each button does (`perform`). It drives one
/// CardProofFlow at a time and turns what the flow returns and throws into
/// a Screen (Screens). It holds no certificate and no signature; the PIN
/// passes through it from the field to the flow.
///
/// Nothing here is saved by the system: no scene storage, no preferences.
/// An app the system ended starts again at step 1.
@MainActor
final class CardProofModel: ObservableObject {
    struct Dependencies {
        var flow: CardProofFlow.Dependencies
        var copy: Copy
        /// The app's own sentences (design/copy/app.json).
        var appCopy: Copy
        /// The reminder to come back, which step 7 offers and every card
        /// proof sets again.
        var reminders: Reminders
        /// The screen to choose the reminder's interval and time.
        var openSchedule: () -> Void
        /// The system's settings, at this app's notifications.
        var openNotificationSettings: () -> Void
        var openSettings: () -> Void
        /// The site of this build: its pages are opened in the browser.
        var site: URL
        /// Opens an address outside the app: the browser, or the platform's app.
        var open: (URL) -> Void
        /// Puts text on the clipboard.
        var copyText: (String) -> Void
        /// The system's share sheet, with a text.
        var share: (String) -> Void
    }

    @Published private(set) var screen: Screen
    /// What the PIN field holds. Emptied as soon as the PIN is handed on.
    @Published var pinText = ""

    /// The sentences, for what every screen has above its blocks.
    var copy: Copy { deps.copy }

    private let deps: Dependencies
    private let screens: Screens
    private var flow: CardProofFlow?
    /// The body of GET /api/v1/config, asked for when the app opens.
    private var config: Data?
    private var configuring: Task<Data, Error>?
    /// The operator stopped taking card proofs, as the config last said
    /// (docs/api/card-proof.md, `paused`): step 1 says so in place of its
    /// button. Until the config answers, and when it does not: false, and
    /// step 2 asks again.
    private var paused = false
    /// The step under way; tests wait for it.
    private(set) var work: Task<Void, Never>?

    private var name = ""
    /// The PIN between the button and the flow, and while another card
    /// than the one read is in the way: the tap is made again with it.
    private var pin: PIN?
    private var status: CardProofFlow.CardStatus?
    /// Which of step 4's screens is up, and what its fields hold.
    private var mode = Screens.AccountsMode.open
    private var typed: [String: String] = [:]
    private var consequence: CardProofFlow.Consequence?
    private var finished: (done: CardProofFlow.Done, single: String?)?
    /// Which of the steps after the record was sent is up.
    private var after = After.hang
    /// "沒有看到連結，重新掛上" was pressed: step 6 is the whole one.
    private var rehanging = false
    private var copied = false
    /// "開啟提醒" was pressed on step 7 and the system said no.
    private var reminderRefused = false
    /// The app was opened from the reminder: step 1 says so until the card proof starts.
    private var fromReminder: FromReminder?
    private var reached = 0

    /// The steps after the record was sent: 6, 7 and 8.
    private enum After { case hang, remind, finish }

    private enum FromReminder {
        case asked
        /// "一週後再提醒我" was pressed.
        case snoozed(ReminderSettings)
    }

    init(_ deps: Dependencies) {
        self.deps = deps
        screens = Screens(copy: deps.copy, appCopy: deps.appCopy, host: deps.site.host ?? "")
        screen = screens.before()
        deps.reminders.observe { [weak self] in self?.redraw() }
    }

    /// The app was opened from the reminder's notification: step 1, with
    /// its note on top until a card proof is done. A card proof under way
    /// is not dropped (a PIN may be in it): the note waits for step 1.
    func openedFromReminder() {
        fromReminder = .asked
        if flow == nil || finished != nil {
            reset()
            screen = before()
        }
    }

    /// When the app opens: asks the server for its `config`, before any
    /// card is read.
    func open() {
        guard configuring == nil, config == nil else { return }
        let backend = deps.flow.backend
        let asked = Task { try await backend.config() }
        configuring = asked
        Task {
            let said = (try? await asked.value).flatMap(CardProofFlow.paused) == true
            // Not when it was asked again meanwhile: the later answer says.
            guard self.configuring == asked else { return }
            self.paused = said
            self.redraw()
        }
    }

    /// Whether a PIN is in memory, here or in the flow: for tests.
    var holdsPIN: Bool {
        (pin.map { !$0.isEmpty } ?? false) || (flow?.holdsPIN ?? false) || !pinText.isEmpty
    }

    /// What the cardholder typed in the field of `platform`.
    func type(_ text: String, on platform: String) {
        guard screen.step == 4, let status, !status.dailyLimit else { return }
        typed[platform] = text
        screen = accounts(status)
    }

    func perform(_ action: Action) {
        switch action {
        case .start, .readAgain:
            reset()
            screen = screens.read(reached: 0, running: false, stop: nil)
        case .back: back()
        case .readCard: run { await self.readCard() }
        case .toPIN:
            screen = screens.pin(name: name, state: .waiting(nil))
        case .confirmCard: run { await self.confirmCard() }
        case .toConfirm: toConfirm()
        case .refresh:
            // The list as it is: nothing to type.
            if let status { confirm(Screens.listNow(status)) }
        case .withdraw:
            // The list without its accounts.
            if let status { confirm(Screens.listNow(status).mapValues { _ in "" }) }
        case .toSwitch: edit(.switching)
        case .editList: edit(.editing)
        case .keep: edit(.open)
        case .findOffice: deps.open(Self.findOffice)
        case .howToApply: deps.open(Self.moica)
        case .declare: run { await self.declare() }
        case .signAgain: run { await self.signAndSubmit() }
        case .submitAgain: run { await self.submit() }
        case .restart:
            reset()
            screen = before()
        case .copyLink:
            guard let finished else { return }
            deps.copyText(proofAddress(finished.done).absoluteString)
            copied = true
            redraw()
        case .openProof:
            if let finished { deps.open(proofAddress(finished.done)) }
        case .openProfile(let platform):
            if let account = finished?.done.accounts.first(where: { $0.platform == platform }),
               let address = Platform.of(platform)?.profile(account.username) { deps.open(address) }
        case .share:
            // The sentence, and on the line under it the card's page (design/copy/card-proof.md, step 8, app).
            if let finished { deps.share("\(screens.shareText(finished.done))\n\(proofAddress(finished.done).absoluteString)") }
        case .preview(let platform): preview(platform)
        case .openSettings: deps.openSettings()
        case .adjustReminder: deps.openSchedule()
        case .rehang:
            rehanging = true
            redraw()
        case .toRemind:
            show(.remind)
            // Refused before, and maybe allowed since in the system's settings.
            askAgain()
        // Not while the system is being asked: what it answers would be set after "這次不要".
        case .toFinish: if work == nil { show(.finish) }
        case .openNotificationSettings: deps.openNotificationSettings()
        case .turnOnReminder:
            run {
                // Set as the screen offered: on to the last step. Refused: step 7 says so.
                if await self.turnOnAsOffered() { self.show(.finish) } else { self.redraw() }
            }
        case .snoozeReminder:
            run { await self.snoozeReminder() }
        }
    }

    /// The phone's map, searching for "戶政事務所": a map link, which Maps
    /// opens (https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MapLinks/MapLinks.html).
    /// The app asks for no location; what is near is the map's to tell.
    /// Nothing of the card proof goes with it (design/copy/card-proof.md, step 1).
    static let findOffice = URL(string: "https://maps.apple.com/?q=%E6%88%B6%E6%94%BF%E4%BA%8B%E5%8B%99%E6%89%80")!
    /// MOICA's site: its page on applying is not checked yet (card-proof.md, step 1).
    static let moica = URL(string: "https://moica.nat.gov.tw/")!

    // The screens that show the reminder ---------------------------------------------

    /// "一週後再提醒我", on step 1 or on the notification: step 1's note,
    /// if it is up, says when the reminder comes now.
    func snoozeReminder() async {
        await deps.reminders.snooze()
        if fromReminder != nil {
            fromReminder = deps.reminders.settings.map(FromReminder.snoozed)
        }
        redraw()
    }

    private func before() -> Screen {
        let reminderScreens = ReminderScreens(appCopy: deps.appCopy)
        switch fromReminder {
        case nil: return screens.before(paused: paused)
        case .asked: return screens.before(notice: reminderScreens.fromNotification(snoozed: nil), paused: paused)
        case .snoozed(let settings): return screens.before(notice: reminderScreens.fromNotification(snoozed: settings), paused: paused)
        }
    }

    /// The app is in front again. Step 7 said the system does not let
    /// the app notify, and the cardholder may have been to the system's
    /// settings: asked again, and set as offered if it is allowed now.
    func cameBack() {
        askAgain()
        // Card proofs the operator stopped may have resumed meanwhile.
        if paused, flow == nil, screen.step == 1 {
            config = nil
            configuring = nil
            open()
        }
    }

    /// Step 7 is up and says the system does not let the app notify: the
    /// system is asked again (it shows nothing once it was refused), and
    /// the reminder is set as offered if it is allowed now. Not when a
    /// reminder was set meanwhile, from the settings: that one stays.
    private func askAgain() {
        guard finished != nil, after == .remind, reminderRefused, deps.reminders.settings == nil else { return }
        run {
            _ = await self.turnOnAsOffered()
            self.redraw()
        }
    }

    /// Turns the reminder on as step 7 offers it, from today. False when
    /// the system does not let the app notify: nothing is kept.
    private func turnOnAsOffered() async -> Bool {
        let offered = deps.reminders.offered
        let allowed = await deps.reminders.turnOn(interval: offered.interval, time: offered.time)
        reminderRefused = !allowed
        return allowed
    }

    /// Another of the steps after the record was sent.
    private func show(_ step: After) {
        guard finished != nil else { return }
        after = step
        redraw()
    }

    /// The screen of the step that is up, after the record was sent.
    private func afterSending(_ finished: (done: CardProofFlow.Done, single: String?)) -> Screen {
        switch after {
        case .hang:
            return screens.hang(finished.done, single: finished.single, copied: copied, whole: rehanging)
        case .remind:
            let reminders = deps.reminders
            let reminder: DoneReminder
            if let settings = reminders.settings {
                reminder = .on(settings, counted: reminders.countedFromToday)
            } else if reminderRefused {
                reminder = .refused
            } else {
                reminder = .ask(reminders.offered)
            }
            return screens.remind(reminder, notAfter: finished.done.notAfter)
        case .finish:
            return screens.finish(finished.done, single: finished.single)
        }
    }

    /// The reminder changed, the link was copied, or another step is up:
    /// the screen that shows it is drawn again.
    private func redraw() {
        if let finished {
            screen = afterSending(finished)
        } else if flow == nil, screen.step == 1 {
            screen = before()
        }
    }

    // ---------------------------------------------------------------------------

    private func run(_ step: @escaping () async -> Void) {
        guard work == nil else { return }
        work = Task {
            await step()
            self.work = nil
        }
    }

    /// Drops the card proof under way, and the PIN with it.
    private func reset() {
        flow?.cancel()
        flow = nil
        pin?.clear()
        pin = nil
        pinText = ""
        name = ""
        status = nil
        mode = .open
        typed = [:]
        consequence = nil
        finished = nil
        after = .hang
        rehanging = false
        copied = false
        reminderRefused = false
        reached = 0
    }

    private func back() {
        switch screen.step {
        case 2:
            reset()
            screen = before()
        case 3:
            // Back to reading the card, which is read again.
            reset()
            screen = screens.read(reached: 0, running: false, stop: nil)
        case 5:
            guard let status, (try? flow?.back()) != nil else { return }
            consequence = nil
            // The screen the button was pressed on, its field as it was typed.
            screen = accounts(status)
        // After the record was sent nothing touches the card: back one step.
        case 7: show(.hang)
        case 8:
            show(.remind)
            askAgain()
        default: break
        }
    }

    private func proofAddress(_ done: CardProofFlow.Done) -> URL {
        deps.site.appendingPathComponent("p").appendingPathComponent(done.shortID)
    }

    // Tap 1 -------------------------------------------------------------------------

    /// The config: the one kept, or the one asked for when the app opened,
    /// or asked for now.
    private func askedConfig() async throws -> Data? {
        if let known = config { return known }
        open()
        guard let configuring else { return nil }
        let config = try await configuring.value
        self.config = config
        return config
    }

    private func readCard() async {
        reset()
        reached = 0
        screen = screens.read(reached: 0, running: true, stop: nil)
        // The server first: the lowest version that may do a card proof is its to say.
        var config: Data
        do {
            guard let known = try await askedConfig() else { return }
            config = known
            if CardProofFlow.paused(config) == true {
                // An answer that said card proofs are stopped is asked again: the operator may have resumed since.
                self.config = nil
                configuring = nil
                guard let again = try await askedConfig() else { return }
                config = again
            }
        } catch {
            configuring = nil
            let failure = error as? BackendFailure ?? BackendFailure(code: "network", requestID: nil)
            screen = screens.read(reached: 0, running: false, stop: .server(failure))
            return
        }
        let flow: CardProofFlow
        do {
            flow = try CardProofFlow(deps.flow, config: config)
        } catch CardProofFlow.Stop.server(let failure) where failure.code == "paused" {
            // Step 1 says so from now on.
            paused = true
            screen = screens.read(reached: 0, running: false, stop: .server(failure))
            return
        } catch {
            screen = screens.read(reached: 0, running: false, stop: error as? CardProofFlow.Stop ?? .state)
            return
        }
        self.flow = flow
        reached = 1
        screen = screens.read(reached: 1, running: true, stop: nil)
        do {
            name = try await flow.readCard { [weak self] progress in
                guard let self, self.flow === flow else { return }
                switch progress {
                case .certificatesRead: self.reached = 2
                case .certificateChecked: self.reached = 3
                }
                self.screen = self.screens.read(reached: self.reached, running: true, stop: nil)
            }
            // The list ends with the CRL; the tree is built while the PIN is typed.
            try await flow.revocationChecked()
            guard self.flow === flow else { return }
            reached = 4
            screen = screens.read(reached: 4, running: false, stop: nil)
        } catch {
            guard self.flow === flow else { return }
            screen = screens.read(reached: reached, running: false, stop: error as? CardProofFlow.Stop ?? .state)
        }
    }

    // Tap 2 -------------------------------------------------------------------------

    private func confirmCard() async {
        guard let flow else { return }
        // Another card was in the way: the PIN typed before is still here.
        let pin = self.pin ?? PIN(pinText)
        self.pin = nil
        pinText = ""
        guard !pin.isEmpty else {
            screen = screens.pin(name: name, state: .waiting(deps.copy("app_pin.need_pin")))
            return
        }
        // A PIN no card takes goes to no card: no tap, nothing used up.
        guard CardChannel.cardTakes(pin) else {
            pin.clear()
            screen = screens.pin(name: name, state: .waiting(deps.copy("app_pin.pin_format")))
            return
        }
        screen = screens.pin(name: name, state: .tapping)
        do {
            let status = try await flow.confirmCard(pin: pin) { [weak self] in
                guard let self, self.flow === flow else { return }
                self.screen = self.screens.pin(name: self.name, state: .signed)
            }
            guard self.flow === flow else { return }
            self.status = status
            mode = .open
            typed = Screens.listNow(status)
            screen = accounts(status)
        } catch {
            guard self.flow === flow else { return }
            let stop = error as? CardProofFlow.Stop ?? .state
            let why = screens.message(stop, tap: 2)
            switch stop {
            case .card(.pinIncorrect), .card(.channel):
                screen = screens.pin(name: name, state: .waiting(why.first))
            case .card(.otherCard):
                self.pin = pin
                screen = screens.pin(name: name, state: .otherCard(why.first ?? ""))
            default:
                screen = screens.pin(name: name, state: .stopped(why))
            }
        }
    }

    // The list ----------------------------------------------------------------------

    private func accounts(_ status: CardProofFlow.CardStatus, errors: [String: String] = [:], message: String? = nil) -> Screen {
        screens.accounts(status, mode: mode, typed: typed, errors: errors, message: message)
    }

    /// Another of step 4's screens: "改成別的帳號" with an empty field,
    /// "修改帳號清單" and "不改了" with the list as it is.
    private func edit(_ mode: Screens.AccountsMode) {
        guard screen.step == 4, let status, !status.dailyLimit else { return }
        self.mode = mode
        typed = Screens.listNow(status)
        if mode == .switching { typed = typed.mapValues { _ in "" } }
        screen = accounts(status)
    }

    /// "下一步" of step 4: the list the fields make.
    private func toConfirm() {
        guard let status else { return }
        guard mode == .switching else { return confirm(typed) }
        // Withdrawing is the other action: an empty field goes nowhere.
        let empty = typed.filter { Platform.of($0.key)?.tidy($0.value).isEmpty ?? $0.value.isEmpty }
        if let platform = empty.keys.sorted().first {
            screen = accounts(status, errors: [platform: deps.copy("accounts.need_one")])
            return
        }
        confirm(typed)
    }

    /// From step 4 to step 5 with `entries`, the account on each platform
    /// the screens offer; what is wrong with them stays on step 4.
    private func confirm(_ entries: [String: String]) {
        guard screen.step == 4, let flow, let status else { return }
        do {
            let consequence = try flow.choose(entries)
            self.consequence = consequence
            screen = screens.confirm(status, consequence)
        } catch {
            show(error as? CardProofFlow.Stop ?? .state, in: status)
        }
    }

    /// What is wrong with the list, on the row it is about or under the list.
    private func show(_ stop: CardProofFlow.Stop, in status: CardProofFlow.CardStatus) {
        let why = screens.message(stop, tap: 2).first ?? ""
        switch stop {
        case .username(let platform), .blocked(_, let platform?):
            screen = accounts(status, errors: [platform: why])
        default:
            screen = accounts(status, message: why)
        }
    }

    private func preview(_ platform: String) {
        guard let flow, let status, let definition = Platform.of(platform) else { return }
        let username = definition.tidy(typed[platform] ?? "")
        guard !username.isEmpty else { return }
        do {
            try flow.checkFormat(of: username, on: platform)
        } catch {
            show(error as? CardProofFlow.Stop ?? .state, in: status)
            return
        }
        if let address = definition.profile(username) { deps.open(address) }
    }

    // Tap 3, the proof, the submission ---------------------------------------------------

    private func declare() async {
        guard let flow else { return }
        reached = 0
        screen = screens.progress(reached: 0, stop: nil)
        do {
            try await flow.prepare()
        } catch {
            guard self.flow === flow else { return }
            screen = screens.progress(reached: 0, stop: error as? CardProofFlow.Stop ?? .state)
            return
        }
        guard self.flow === flow else { return }
        reached = 1
        await signAndSubmit()
    }

    private func signAndSubmit() async {
        guard let flow else { return }
        screen = screens.progress(reached: 1, stop: nil)
        do {
            try await flow.sign()
            guard self.flow === flow else { return }
            reached = 2
            screen = screens.progress(reached: 2, stop: nil)
            try await flow.prove()
            guard self.flow === flow else { return }
            reached = 3
        } catch {
            guard self.flow === flow else { return }
            screen = screens.progress(reached: reached, stop: error as? CardProofFlow.Stop ?? .state)
            return
        }
        await submit()
    }

    private func submit() async {
        guard let flow, let status else { return }
        screen = screens.progress(reached: 3, stop: nil)
        do {
            let done = try await flow.submit()
            guard self.flow === flow else { return }
            let single = Screens.onePlatform(status)
            reset()
            fromReminder = nil
            // Set again from today, as last chosen, before the screen says when.
            await deps.reminders.cardProofDone()
            finished = (done, single)
            // Everything withdrawn: nothing to hang, to be reminded of or to share.
            after = done.accounts.isEmpty ? .finish : .hang
            redraw()
        } catch {
            guard self.flow === flow else { return }
            screen = screens.progress(reached: 3, stop: error as? CardProofFlow.Stop ?? .state, submitFailed: flow.phase == .submitFailed)
        }
    }
}
