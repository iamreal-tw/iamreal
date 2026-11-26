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
        /// Whether this phone can read a card at all.
        var canReadCards: () -> Bool = { true }
        /// What the server's lowest version says of this build, from the
        /// body of its config and the phone's clock (spec/min-app.md).
        var minApp: (_ config: Data, _ now: Date) -> MinApp = { _, _ in .ok }
        /// The app's page in the store; none in a build that has no such page yet.
        var storePage: URL?
    }

    /// How long a PIN may stay in memory: from the moment it is taken from
    /// the field to the last time it goes to the card, five minutes at
    /// most (issue #133).
    static let pinLifetime: TimeInterval = 5 * 60

    @Published private(set) var screen: Screen
    /// What the PIN field holds. Emptied as soon as the PIN is handed on.
    @Published var pinText = "" {
        // A PIN is in memory from its first character: its five minutes start then.
        didSet { if oldValue.isEmpty, !pinText.isEmpty, pinDeadline == nil { startPINClock() } }
    }

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
    /// What `config` answered when step 1's 下一步 was last pressed
    /// (GET /api/v1/config?start), when it could be read: the card proofs
    /// that follow fall back on it when the server turns the `config` they
    /// ask away as too many (docs/api/card-proof.md, `config`).
    private var startConfig: Data?
    /// Step 1's 下一步 was pressed, and the server has not answered yet.
    private var starting = false
    /// The server turned the start away as too many: step 1 says so above
    /// its 下一步, which stays, to be pressed again (card-proof.md, step 1,
    /// 人太多的時候).
    private var startTurnedAway = false
    /// The counts of the card proof to come or under way (Counts); its first count is `open`, as step 1 shows.
    private var attempt: Counts.Attempt?
    /// What the server's lowest version says of this build, as the config
    /// last said. Until the config answers: as if it were not too old.
    private var version = MinApp.ok
    /// When the PIN in memory is dropped whatever the card proof is at, and when its five minutes started.
    private var pinDeadline: Date?
    private var pinSince: Date?
    private var pinTimer: Task<Void, Never>?
    /// The card proof came back to step 1 after five minutes: step 1 says so until it starts again.
    private var idle = false
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
    /// The demonstration of step 6 is playing; it has played in this card proof.
    private var demoPlaying = false
    private var demoPlayed = false
    /// The demonstration of step 2 is playing; it has played since the step came up.
    private var sensePlaying = false
    private var sensePlayed = false
    /// What step 2 shows: how far the list is, whether a tap is under way, why it stopped.
    private var reading: (reached: Int, running: Bool, stop: CardProofFlow.Stop?) = (0, false, nil)
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
        screens = Screens(copy: deps.copy, appCopy: deps.appCopy, host: deps.site.host ?? "", storePage: deps.storePage != nil)
        screen = screens.before()
        if !deps.canReadCards() { screen = screens.noNFC() }
        deps.reminders.observe { [weak self] in self?.redraw() }
    }

    /// The app was opened from the reminder's notification: step 1, with
    /// its note on top until a card proof is done. A card proof under way
    /// is not dropped (a PIN may be in it): the note waits for step 1.
    func openedFromReminder() {
        fromReminder = .asked
        if flow == nil || finished != nil {
            reset()
            askConfigAgain()
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
            let answer = try? await asked.value
            // Not when it was asked again meanwhile: the later answer says.
            guard self.configuring == asked else { return }
            // Kept for the card proof that follows; one that did not come is asked for again.
            if let answer { self.config = answer } else { self.configuring = nil }
            self.paused = answer.flatMap(CardProofFlow.paused) == true
            if let answer { self.version = self.deps.minApp(answer, self.deps.flow.clock()) }
            self.redraw()
        }
    }

    /// Step 1 asks the server for its config each time it opens, as the
    /// web page does (card-proof.md, step 1: the operator stopping card
    /// proofs is said before a card is read); the card proof that follows
    /// uses that answer. Not while an answer is still to come.
    private func askConfigAgain() {
        guard config != nil || configuring == nil else { return }
        config = nil
        configuring = nil
        open()
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
        // Five minutes with the PIN in memory are over: back to the start, whatever was pressed.
        if dropPINIfItsTimeIsUp() { return }
        switch action {
        case .start:
            // Not from a screen that stands in the place of step 1.
            guard deps.canReadCards(), !version.stops else { return }
            run { await self.start() }
        case .readAgain:
            reset()
            // The card was tapped once already: the demonstration is at rest, and plays again only by its button.
            sensePlayed = true
            screen = read(reached: 0, running: false, stop: nil)
        case .back: back()
        case .readCard: run { await self.readCard() }
        case .toPIN:
            screen = screens.pin(name: name, state: .waiting(nil))
        case .confirmCard: run { await self.confirmCard() }
        case .retryCardState: run { await self.retryCardState() }
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
        case .openStore: if let page = deps.storePage { deps.open(page) }
        case .findOffice: deps.open(Self.findOffice)
        case .howToApply: deps.open(Self.moica)
        case .declare: run { await self.declare() }
        case .signAgain: run { await self.signAndSubmit() }
        case .submitAgain: run { await self.submit() }
        case .restart:
            reset()
            askConfigAgain()
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
        // By itself only once in a card proof: not again on the way back from step 7.
        case .showDemo: if !demoPlayed { playDemo(true) }
        case .playDemo: playDemo(true)
        case .stopDemo: playDemo(false)
        case .toRemind:
            demoPlaying = false
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
        opened()
        // A phone that cannot read a card, a version that can no longer do a card proof: in the place of step 1.
        guard deps.canReadCards() else { return screens.noNFC() }
        if case .stop(let from) = version { return screens.tooOld(from: from) }
        var updateFrom: String?
        if case .okUntil(let from) = version { updateFrom = from }
        let reminderScreens = ReminderScreens(appCopy: deps.appCopy)
        let notice: Notice?
        switch fromReminder {
        case nil: notice = nil
        case .asked: notice = reminderScreens.fromNotification(snoozed: nil)
        case .snoozed(let settings): notice = reminderScreens.fromNotification(snoozed: settings)
        }
        return screens.before(notice: notice, paused: paused, updateFrom: updateFrom, idle: idle, busy: startTurnedAway, starting: starting)
    }

    // The counts -------------------------------------------------------------------------

    /// Step 1 shows: the first screen of a card proof (spec/counts.md,
    /// `open`). A new attempt, unless the one there has not begun.
    private func opened() {
        guard let counts = deps.flow.counts, attempt?.begun ?? true else { return }
        attempt = counts.attempt()
        attempt?.step("open")
    }

    /// The attempt of the card proof going on: the one step 1 opened, or
    /// a new one if it has begun (a card proof started again from step 2).
    private func going() -> Counts.Attempt? {
        if let attempt, !attempt.begun { return attempt }
        attempt = deps.flow.counts?.attempt()
        return attempt
    }

    /// The card proof stopped before a flow had it: `stop`'s reason.
    private func stopped(_ stop: CardProofFlow.Stop) {
        if let reason = Counts.reason(of: stop) { going()?.stop(reason) }
    }

    // Step 1's 下一步 ------------------------------------------------------------------

    /// The start of a card proof: `config` asked with the mark of a start,
    /// the one request of a card proof the server counts against its
    /// site-wide limit (docs/api/card-proof.md, `config`; ADR-0026), before
    /// step 2. Turned away as too many, step 1 stays and says so; card
    /// proofs stopped, step 1 says that in place of 下一步. No answer, or
    /// another refusal: on to step 2, whose reading asks again.
    private func start() async {
        idle = false
        startTurnedAway = false
        starting = true
        screen = before()
        let answer: Data?
        do {
            answer = try await deps.flow.backend.config(start: true)
        } catch let failure as BackendFailure where failure.tooMany {
            starting = false
            startTurnedAway = true
            stopped(.server(failure))
            screen = before()
            return
        } catch {
            answer = nil
        }
        starting = false
        if let answer {
            if CardProofFlow.paused(answer) == true {
                paused = true
                stopped(.server(BackendFailure(code: "paused", requestID: nil)))
                screen = before()
                return
            }
            // Only what a card proof can start from is one to fall back on: the reading asks again in any case.
            startConfig = (try? CardProofFlow(deps.flow, config: answer)) != nil ? answer : nil
            version = deps.minApp(answer, deps.flow.clock())
            if version.stops {
                going()?.stop("app_too_old")
                screen = before()
                return
            }
        } else {
            startConfig = nil
        }
        // The reading asks config again, without the mark: asked now, while step 2 comes up.
        askConfigAgain()
        reset()
        // The demonstration of where the card goes plays as the step comes up.
        sensePlaying = true
        screen = read(reached: 0, running: false, stop: nil)
    }

    // The PIN's five minutes ---------------------------------------------------------

    /// A PIN came into memory, in the field: from now it has five minutes.
    private func startPINClock() {
        let now = deps.flow.clock()
        pinSince = now
        pinDeadline = now.addingTimeInterval(Self.pinLifetime)
        pinTimer?.cancel()
        pinTimer = Task { [weak self] in
            // Until the PIN is gone: the system may hold the app meanwhile, and the phone's clock may be set.
            while !Task.isCancelled {
                guard let self, let left = self.pinTimeLeft else { return }
                if left <= 0 {
                    if self.dropPINIfItsTimeIsUp() { return }
                    // A tap or a request is under way: again when it has had time to end.
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                } else {
                    try? await Task.sleep(nanoseconds: UInt64(min(left, Self.pinLifetime) * 1_000_000_000))
                }
            }
        }
    }

    private func stopPINClock() {
        pinDeadline = nil
        pinSince = nil
        pinTimer?.cancel()
        pinTimer = nil
    }

    /// The seconds the PIN in memory still has; nil when no clock runs.
    /// None left as well when the phone's clock is before the moment the
    /// PIN was typed: a clock set back does not give the PIN more time.
    private var pinTimeLeft: TimeInterval? {
        guard let pinDeadline, let pinSince else { return nil }
        let now = deps.flow.clock()
        return now < pinSince ? 0 : pinDeadline.timeIntervalSince(now)
    }

    /// No PIN is in memory any more (it was sent the last time, or
    /// dropped): its clock stops, so that it is not counted against the
    /// next PIN typed.
    private func stopPINClockIfThePINIsGone() {
        if !holdsPIN { stopPINClock() }
    }

    /// Five minutes after a PIN came into memory and one still there: it
    /// is dropped with the card proof, and step 1 says why (card-proof.md,
    /// step 1, "app"). Not in the middle of a tap or a request: when that
    /// ends (`run`), and before the PIN goes to the card the last time
    /// (`declare`). True when it did so.
    @discardableResult
    private func dropPINIfItsTimeIsUp() -> Bool {
        guard work == nil else { return false }
        return dropPINNowIfItsTimeIsUp()
    }

    /// The same, also from inside the step under way.
    private func dropPINNowIfItsTimeIsUp() -> Bool {
        guard let left = pinTimeLeft, left <= 0 else { return false }
        guard holdsPIN else {
            stopPINClock()
            return false
        }
        attempt?.stop("idle")
        reset()
        idle = true
        askConfigAgain()
        screen = before()
        return true
    }

    /// The app is in front again. Step 7 said the system does not let
    /// the app notify, and the cardholder may have been to the system's
    /// settings: asked again, and set as offered if it is allowed now.
    func cameBack() {
        // The system does not run the app's clock while it is held in the background.
        if dropPINIfItsTimeIsUp() { return }
        askAgain()
        // The operator may have stopped card proofs, or resumed them, meanwhile.
        if flow == nil, screen.step <= 1 { askConfigAgain() }
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

    /// Step 2 as it is now, with its demonstration.
    private func read(reached: Int, running: Bool, stop: CardProofFlow.Stop?) -> Screen {
        reading = (reached, running, stop)
        if sensePlaying { sensePlayed = true }
        return screens.read(reached: reached, running: running, stop: stop, demoPlaying: sensePlaying, demoPlayed: sensePlayed)
    }

    /// The demonstration of the step that is up (2 or 6) from its start,
    /// or at its last frame. The screen draws it; here is only which, for
    /// its one button.
    private func playDemo(_ playing: Bool) {
        // Step 2's, of where the card goes: not while a tap is under way.
        if finished == nil, screen.step == 2 {
            guard !reading.running, sensePlaying != playing else { return }
            sensePlaying = playing
            if playing { sensePlayed = true }
            screen = read(reached: reading.reached, running: reading.running, stop: reading.stop)
            return
        }
        guard finished != nil, after == .hang, demoPlaying != playing else { return }
        demoPlaying = playing
        if playing { demoPlayed = true }
        redraw()
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
            return screens.hang(finished.done, single: finished.single, copied: copied, whole: rehanging, demoPlaying: demoPlaying, demoPlayed: demoPlayed)
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
        } else if flow == nil, screen.step <= 1 {
            // Step 1, or the screen in its place.
            screen = before()
        }
    }

    // ---------------------------------------------------------------------------

    private func run(_ step: @escaping () async -> Void) {
        guard work == nil else { return }
        work = Task {
            await step()
            self.work = nil
            // The five minutes may have ended meanwhile.
            self.dropPINIfItsTimeIsUp()
        }
    }

    /// Drops the card proof under way, and the PIN with it.
    private func reset() {
        flow?.cancel()
        flow = nil
        stopPINClock()
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
        demoPlaying = false
        demoPlayed = false
        sensePlaying = false
        sensePlayed = false
        copied = false
        reminderRefused = false
        reached = 0
    }

    private func back() {
        switch screen.step {
        case 2:
            reset()
            askConfigAgain()
            screen = before()
        case 3:
            // Back to reading the card, which is read again.
            reset()
            sensePlaying = true
            screen = read(reached: 0, running: false, stop: nil)
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
        // The tap is on: the demonstration is at rest, and does not play again by itself.
        sensePlayed = true
        reached = 0
        screen = read(reached: 0, running: true, stop: nil)
        let attempt = going()
        attempt?.step("read")
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
        } catch let failure as BackendFailure where failure.tooMany && startConfig != nil {
            // Turned away as too many: the card proof goes on with the config of its start (docs/api/card-proof.md, `config`).
            configuring = nil
            config = startConfig!
        } catch {
            configuring = nil
            let failure = error as? BackendFailure ?? BackendFailure(code: "network", requestID: nil)
            stopped(.server(failure))
            screen = read(reached: 0, running: false, stop: .server(failure))
            return
        }
        // The server answered its config.
        if CardProofFlow.paused(config) == false { attempt?.step("config") }
        // The lowest version, from the config this card proof will use: before any card is read.
        version = deps.minApp(config, deps.flow.clock())
        switch version {
        case .stop:
            attempt?.stop("app_too_old")
            // In the place of step 1 from now on.
            screen = before()
            return
        case .unreadable:
            // As a platform table that cannot be read: the card proof does not go on (ADR-0035).
            let stop = CardProofFlow.Stop.server(BackendFailure(code: "malformed_response", requestID: nil))
            stopped(stop)
            screen = read(reached: 0, running: false, stop: stop)
            return
        case .ok, .okUntil:
            break
        }
        let flow: CardProofFlow
        do {
            flow = try CardProofFlow(deps.flow, config: config, attempt: attempt)
        } catch CardProofFlow.Stop.server(let failure) where failure.code == "paused" {
            // Step 1 says so from now on.
            paused = true
            stopped(.server(failure))
            screen = read(reached: 0, running: false, stop: .server(failure))
            return
        } catch {
            let stop = error as? CardProofFlow.Stop ?? .state
            stopped(stop)
            screen = read(reached: 0, running: false, stop: stop)
            return
        }
        self.flow = flow
        reached = 1
        screen = read(reached: 1, running: true, stop: nil)
        do {
            name = try await flow.readCard { [weak self] progress in
                guard let self, self.flow === flow else { return }
                switch progress {
                case .certificatesRead: self.reached = 2
                case .certificateChecked: self.reached = 3
                }
                self.screen = self.read(reached: self.reached, running: true, stop: nil)
            }
            // The list ends with the CRL; the tree is built while the PIN is typed.
            try await flow.revocationChecked()
            guard self.flow === flow else { return }
            reached = 4
            screen = read(reached: 4, running: false, stop: nil)
        } catch CardProofFlow.Stop.card(.cancelled) {
            // The panel was closed: the step as before the button, no reason.
            guard self.flow === flow else { return }
            reached = 0
            screen = read(reached: 0, running: false, stop: nil)
        } catch {
            guard self.flow === flow else { return }
            screen = read(reached: reached, running: false, stop: error as? CardProofFlow.Stop ?? .state)
        }
    }

    // Tap 2 -------------------------------------------------------------------------

    private func confirmCard() async {
        await confirmCardOnce()
        // The PIN was refused or dropped: its five minutes are not the next PIN's.
        stopPINClockIfThePINIsGone()
    }

    private func confirmCardOnce() async {
        guard let flow else { return }
        // The tap is made again: the PIN typed before is still here. One typed since takes its place.
        let pin: PIN
        if let kept = self.pin, pinText.isEmpty {
            pin = kept
        } else {
            self.pin?.clear()
            pin = PIN(pinText)
        }
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
            showAccounts(status)
        } catch {
            guard self.flow === flow else { return }
            let stop = error as? CardProofFlow.Stop ?? .state
            let why = screens.message(stop, tap: 2)
            switch stop {
            case _ where stop.tooMany:
                // The card signed; the flow keeps the PIN for tap 3, and 再試一次 asks for the card's state again.
                screen = screens.pin(name: name, state: .retry(why))
            case .card(.pinIncorrect), .card(.channel), .card(.dropped(.sent)):
                // The flow dropped the PIN: it is typed again.
                screen = screens.pin(name: name, state: .waiting(why.first))
            case .card(.cancelled):
                // The panel was closed: the screen as before the button, no reason; the PIN is still here.
                self.pin = pin
                screen = screens.pin(name: name, state: .waiting(nil))
            case .card(.otherCard), .card(.noTap), .card(.dropped):
                self.pin = pin
                screen = screens.pin(name: name, state: .tapAgain(why.first ?? ""))
            default:
                screen = screens.pin(name: name, state: .stopped(why))
            }
        }
    }

    /// 再試一次 of step 3: the card's state asked again, after the server
    /// turned it away as too many. Nothing is signed again.
    private func retryCardState() async {
        guard let flow else { return }
        // The PIN for the last tap is the flow's: one typed into the field meanwhile goes to no card, and is not kept.
        pinText = ""
        screen = screens.pin(name: name, state: .signed)
        do {
            let status = try await flow.retryCardState()
            guard self.flow === flow else { return }
            showAccounts(status)
        } catch {
            guard self.flow === flow else { return }
            let stop = error as? CardProofFlow.Stop ?? .state
            let why = screens.message(stop, tap: 2)
            if stop.tooMany {
                screen = screens.pin(name: name, state: .retry(why))
            } else {
                screen = screens.pin(name: name, state: .stopped(why))
            }
        }
        stopPINClockIfThePINIsGone()
    }

    /// Step 4, as it opens for the card's state.
    private func showAccounts(_ status: CardProofFlow.CardStatus) {
        self.status = status
        mode = .open
        typed = Screens.listNow(status)
        screen = accounts(status)
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
        // The server took its time: the PIN does not go to the card past its five minutes.
        if dropPINNowIfItsTimeIsUp() { return }
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

/// What the server's lowest version says of this build (spec/min-app.md).
enum MinApp: Equatable {
    /// The build is new enough.
    case ok
    /// Older than the lowest, before the day it starts on: a card proof
    /// goes on, and the app says from which day it cannot.
    case okUntil(String)
    /// Older than the lowest, on that day or after: no card, no PIN.
    case stop(String)
    /// The field cannot be read: the app does not go on either.
    case unreadable

    /// A card proof may not start.
    var stops: Bool {
        if case .stop = self { return true }
        return false
    }

    /// As the core reads the server's `config` for the build `build` of
    /// this app (DeviceCore.minApp). A build number that is not one, or an
    /// answer of the core's the app cannot read, is as a field it cannot
    /// read: the app does not go on.
    static func read(config: Data, build: String?, now: Date) -> MinApp {
        guard let build = build.flatMap(UInt32.init),
              let answer = try? DeviceCore.minApp(config: config, build: build, now: now),
              let verdict = try? JSONSerialization.jsonObject(with: answer) as? [String: Any]
        else { return .unreadable }
        switch (verdict["verdict"] as? String, verdict["from"] as? String) {
        case ("ok", _): return .ok
        case ("ok_until", let from?): return .okUntil(from)
        case ("stop", let from?): return .stop(from)
        default: return .unreadable
        }
    }
}
