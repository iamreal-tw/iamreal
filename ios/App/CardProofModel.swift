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
        /// The reminder to come back, which the done screen offers and
        /// every card proof sets again.
        var reminders: Reminders
        /// The screen to choose the reminder's interval and time.
        var openSchedule: () -> Void
        var openSettings: () -> Void
        /// The site of this build: its pages are opened in the browser.
        var site: URL
        /// Opens an address outside the app: the browser, or the platform's app.
        var open: (URL) -> Void
        /// Puts text on the clipboard.
        var copyText: (String) -> Void
        /// The system's share sheet, with an address.
        var share: (URL) -> Void
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
    /// The step under way; tests wait for it.
    private(set) var work: Task<Void, Never>?

    private var name = ""
    /// The PIN between the button and the flow, and while another card
    /// than the one read is in the way: the tap is made again with it.
    private var pin: PIN?
    private var status: CardProofFlow.CardStatus?
    private var typed: [String: String] = [:]
    private var consequence: CardProofFlow.Consequence?
    private var finished: (done: CardProofFlow.Done, single: String?)?
    private var copied = false
    /// "開啟提醒" was pressed on this done screen and the system said no.
    private var reminderRefused = false
    /// The app was opened from the reminder: step 1 says so until the card proof starts.
    private var fromReminder: FromReminder?
    private var reached = 0

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
        configuring = Task { try await backend.config() }
    }

    /// Whether a PIN is in memory, here or in the flow: for tests.
    var holdsPIN: Bool {
        (pin.map { !$0.isEmpty } ?? false) || (flow?.holdsPIN ?? false) || !pinText.isEmpty
    }

    /// What the cardholder typed in the field of `platform`.
    func type(_ text: String, on platform: String) {
        guard screen.step == 4, let status, !status.dailyLimit else { return }
        typed[platform] = text
        screen = screens.accounts(status, typed: typed, errors: [:], message: nil)
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
            screen = done(finished)
        case .openProof:
            if let finished { deps.open(proofAddress(finished.done)) }
        case .openProfile(let platform):
            if let account = finished?.done.accounts.first(where: { $0.platform == platform }),
               let address = Platform.of(platform)?.profile(account.username) { deps.open(address) }
        case .share:
            // The card's page only: no words of the app's own.
            if let finished { deps.share(proofAddress(finished.done)) }
        case .preview(let platform): preview(platform)
        case .openSettings: deps.openSettings()
        case .adjustReminder: deps.openSchedule()
        case .turnOnReminder:
            run {
                // What the screen offered, from today.
                let offered = self.deps.reminders.offered
                self.reminderRefused = !(await self.deps.reminders.turnOn(interval: offered.interval, time: offered.time))
                self.redraw()
            }
        case .snoozeReminder:
            run { await self.snoozeReminder() }
        }
    }

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
        case nil: return screens.before()
        case .asked: return screens.before(notice: reminderScreens.fromNotification(snoozed: nil))
        case .snoozed(let settings): return screens.before(notice: reminderScreens.fromNotification(snoozed: settings))
        }
    }

    private func done(_ finished: (done: CardProofFlow.Done, single: String?)) -> Screen {
        let reminders = deps.reminders
        let reminder: DoneReminder
        if let settings = reminders.settings {
            reminder = .on(settings, counted: reminders.countedFromToday)
        } else if reminderRefused {
            reminder = .refused
        } else {
            reminder = .ask(reminders.offered)
        }
        return screens.done(finished.done, single: finished.single, copied: copied, reminder: reminder)
    }

    /// The reminder changed, or the app was opened from it: the screen
    /// that shows it is drawn again.
    private func redraw() {
        if let finished, screen.step == 6 {
            screen = done(finished)
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
        typed = [:]
        consequence = nil
        finished = nil
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
            screen = screens.accounts(status, typed: typed, errors: [:], message: nil)
        default: break
        }
    }

    private func proofAddress(_ done: CardProofFlow.Done) -> URL {
        deps.site.appendingPathComponent("p").appendingPathComponent(done.shortID)
    }

    // Tap 1 -------------------------------------------------------------------------

    private func readCard() async {
        reset()
        reached = 0
        screen = screens.read(reached: 0, running: true, stop: nil)
        // The server first: the lowest version that may do a card proof is its to say.
        let config: Data
        do {
            if let known = self.config {
                config = known
            } else {
                open()
                guard let configuring else { return }
                config = try await configuring.value
                self.config = config
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
        screen = screens.pin(name: name, state: .tapping)
        do {
            let status = try await flow.confirmCard(pin: pin) { [weak self] in
                guard let self, self.flow === flow else { return }
                self.screen = self.screens.pin(name: self.name, state: .signed)
            }
            guard self.flow === flow else { return }
            self.status = status
            typed = Dictionary(uniqueKeysWithValues: status.rows.filter(\.known).map { ($0.platform, $0.current ?? "") })
            screen = screens.accounts(status, typed: typed, errors: [:], message: nil)
        } catch {
            guard self.flow === flow else { return }
            let stop = error as? CardProofFlow.Stop ?? .state
            let why = screens.message(stop, tap: 2)
            switch stop {
            case .card(.pinIncorrect):
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

    private func toConfirm() {
        guard let flow, let status else { return }
        do {
            let consequence = try flow.choose(typed)
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
            screen = screens.accounts(status, typed: typed, errors: [platform: why], message: nil)
        default:
            screen = screens.accounts(status, typed: typed, errors: [:], message: why)
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
            screen = self.done((done, single))
        } catch {
            guard self.flow === flow else { return }
            screen = screens.progress(reached: 3, stop: error as? CardProofFlow.Stop ?? .state, submitFailed: flow.phase == .submitFailed)
        }
    }
}
