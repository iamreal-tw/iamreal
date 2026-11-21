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
        /// The site of this build: its pages are opened in the browser.
        var site: URL
        /// Opens an address outside the app: the browser, or the platform's app.
        var open: (URL) -> Void
        /// Puts text on the clipboard.
        var copyText: (String) -> Void
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
    private var reached = 0

    init(_ deps: Dependencies) {
        self.deps = deps
        screens = Screens(copy: deps.copy, host: deps.site.host ?? "")
        screen = screens.before()
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
            screen = screens.before()
        case .copyLink:
            guard let finished else { return }
            deps.copyText(proofAddress(finished.done).absoluteString)
            screen = screens.done(finished.done, single: finished.single, copied: true)
        case .openProof:
            if let finished { deps.open(proofAddress(finished.done)) }
        case .openPlatform:
            if let account = finished?.done.accounts.first(where: { Platform.of($0.platform) != nil }),
               let address = Platform.of(account.platform)?.profile(account.username) { deps.open(address) }
        case .preview(let platform): preview(platform)
        case .help(let topic):
            var address = URLComponents(url: deps.site.appendingPathComponent("proof/help.html"), resolvingAgainstBaseURL: false)
            address?.queryItems = [URLQueryItem(name: "topic", value: topic)]
            if let address = address?.url { deps.open(address) }
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
        reached = 0
    }

    private func back() {
        switch screen.step {
        case 2:
            reset()
            screen = screens.before()
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
            finished = (done, single)
            screen = screens.done(done, single: single, copied: false)
        } catch {
            guard self.flow === flow else { return }
            screen = screens.progress(reached: 3, stop: error as? CardProofFlow.Stop ?? .state, submitFailed: flow.phase == .submitFailed)
        }
    }
}
