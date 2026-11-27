import Foundation

/// One card proof, as a state machine without a screen, in the order of
/// the web page's (web/src/flow.ts; the steps and the three taps are those
/// of issue #133):
///
///   readCard()        tap 1: the certificates, no PIN. The core chooses
///                     and checks the certificate; then the checks that
///                     need no signature start: the CRL (downloaded and
///                     checked), the tree, the files a proof needs
///   revocationChecked()  returns when the CRL passed; the screen then
///                     asks for the PIN, while the tree is built
///   checksDone()      returns when every one of those passed
///   confirmCard(pin)  tap 2: the card signs the scope string; the core
///                     computes the scoped ID; the card's state
///   retryCardState()  the card's state again, after the server turned it
///                     away as too many; nothing signed again
///   choose(entries)   the account typed on each platform offered: the list
///                     the card would sign and what it does (the core
///                     computes it). No request, no signature
///   back()            from the consequence to the card's state again
///   prepare()         the date conditions again; a challenge, dated today;
///                     the list still does what the screen said; the
///                     declaration code. Again after the server turned the
///                     challenge away as too many
///   sign()            tap 3: the card signs the declaration code; the PIN
///                     is cleared
///   prove()           the proof, made by the core; the certificate and the
///                     signatures are overwritten
///   submit()          the record goes to the server; again after a
///                     failure, as it is, and after the server turned it
///                     away as too many
///   cancel()          drops everything
///
/// Nothing is asked of a person or of the network during a tap: the
/// challenge and the card's state are fetched between taps.
///
/// In taps 2 and 3 the certificates are read again and the chosen one must
/// be among them before the PIN goes to the card (`CardFailure.otherCard`
/// otherwise; the step can be done again with the right card).
///
/// The core holds the order: it computes no scoped ID and writes no
/// request before its own checks passed (device-core/README.md). This
/// class only calls it in that order.
///
/// Where each value is:
///   PIN              from the caller, in a `PIN`; kept from confirmCard()
///                    until tap 3 was made, the flow stops or is cancelled;
///                    then overwritten. Never written anywhere
///   certificate,     from the card; the chosen certificate and the first
///   signatures       signature stay here until the proof is made, then
///                    are overwritten; the core's copies go with its session
///   name             from the core's check of the certificate, returned
///                    to the caller for the screen; sent nowhere
///   failures         thrown to the caller; of a failure only its reason
///                    code goes in a count (Counts), never its text
///
/// The counts (Counts, spec/counts.md): each step the table names is sent
/// once as it is reached; a failure that stops the flow as `stop`, one
/// that leaves the step to be done again as `retry`; a card that left
/// during a tap as an action, and the record sent again as another. The
/// flow cancelled, or a call refused as out of order, is not counted.
/// Nothing waits for them.
@MainActor
final class CardProofFlow {
    struct Dependencies {
        /// Which proof log's scope string the card signs: fixed by the build.
        var proofLog: DeviceCore.ProofLog
        var backend: Backend
        var card: Card
        /// The device's clock.
        var clock: () -> Date
        var crlNumbers: CRLNumbers
        /// Opens the core's session: one that checks against MOICA's keys.
        var openSession: () throws -> DeviceCore.Session
        /// The files a proof needs, for the issuer of the certificate (G2, G3).
        var proofFiles: (_ issuer: String) throws -> DeviceCore.ProofFiles
        /// The counts of this run of the app: the card proof device ID of the
        /// submission. None in a test that does not look at them.
        var counts: Counts?
    }

    /// Why a step did not do what it is for.
    enum Stop: Error, Equatable {
        case card(CardFailure)
        /// A reason code of spec/device-checks.md, "The certificate";
        /// `date` is the certificate's time the reason is about
        /// (YYMMDDHHMMSS), when it has one.
        case certificate(problem: String, date: String?)
        /// A reason code of spec/device-checks.md for the CRL, or
        /// `revoked`; `days` is the CRL's age for `crl_stale`.
        case revocation(problem: String, days: Int?)
        /// The card's signature is not the certificate's over the message.
        case cardSignature
        case server(BackendFailure)
        /// A file a proof needs is not the one written into the core.
        case artifact
        /// The core failed, or refused a call: a mistake of the app.
        case core(Int32)
        /// The account typed for `platform` is not in its format.
        case username(platform: String)
        /// The list is not possible by the record rules: `empty`,
        /// `daily_limit`, or `switch_limit` on `platform`.
        case blocked(reason: String, platform: String?)
        /// The challenge is not dated today in Taiwan by the device's
        /// clock. Nothing was signed.
        case challengeNotToday
        /// A step called out of order.
        case state

        /// The server turned the request away as too many (BackendFailure.tooMany): the same request can be sent again.
        var tooMany: Bool {
            if case .server(let failure) = self { return failure.tooMany }
            return false
        }
    }

    /// What tap 1 has done, for the screen's list.
    enum Progress: Equatable {
        case certificatesRead
        case certificateChecked
    }

    enum Phase: Equatable {
        case start, checking, cardStateTurnedAway, statusKnown, chosen, readyToSign, signed, submitting, submitFailed, done, stopped
    }

    struct Account: Equatable {
        let platform: String
        let username: String
    }

    /// One row of the card's state (idc_card_status).
    struct StatusRow: Equatable {
        let platform: String
        /// False for an account kept on a platform the app does not know.
        let known: Bool
        let current: String?
        let lastDeclared: String?
        let switchCount: Int
        let switchesLeft: Int
    }

    struct CardStatus: Equatable {
        let shortID: String
        let lastCardProof: String?
        let daysSince: Int?
        let dailyLimit: Bool
        /// The platforms of the server's table the app knows.
        let knownPlatforms: [String]
        let rows: [StatusRow]
    }

    /// What a list does on one platform (idc_list_consequence, a row).
    struct ConsequenceRow: Equatable {
        let platform: String
        let known: Bool
        let kind: String
        let username: String
        let current: String?
        let previous: String?
        let switchesLeft: Int?
    }

    struct Consequence: Equatable {
        /// The list the card will sign.
        let accounts: [Account]
        let rows: [ConsequenceRow]
        let firstRecord: Bool
        /// The date the record would have: today in Taiwan.
        let today: String
    }

    /// What the server says the record is on one platform: an element of
    /// its answer's `kinds`.
    struct Recorded: Equatable {
        let platform: String
        let kind: String
        /// The account: the list's for that platform, or for `withdraw`
        /// the one withdrawn.
        let username: String
        /// The cards that declare this account once the record is applied;
        /// nil when the answer has no such count.
        let accountCards: Int?
    }

    /// The server's answer to the submission, a 201, as the core read it
    /// (spec/records-response.md). The record is in the proof log whatever
    /// the answer holds: what cannot be read is nil, never a failure.
    struct Answer: Equatable {
        /// The record's `seq` and hash; both nil when nothing of the
        /// answer is told.
        let seq: Int?
        let recordHash: String?
        /// The card's ordinal, for the text suggested for sharing; nil
        /// when it cannot be read, or nothing of the answer is told.
        let ordinal: Int?
        /// What the server says the record is on each platform, in
        /// ascending order; nil when it cannot be read.
        let kinds: [Recorded]?
        /// The platforms on which `kinds` differs from the confirmation
        /// screen's rows, in ascending order; empty when `kinds` is nil.
        let mismatches: [String]

        /// An answer of which nothing is told.
        static let nothing = Answer(seq: nil, recordHash: nil, ordinal: nil, kinds: nil, mismatches: [])

        /// Reads `response`, the body of the 201, against `rows`, the
        /// rows the confirmation screen showed as the core takes them.
        /// The app cannot check the answer; the core only compares.
        static func read(_ response: Data, rows: Data) -> Answer {
            // The record is in the proof log: the core failing to read its answer does not undo it.
            guard let json = try? DeviceCore.recordsResponse(response, rows: rows),
                  let read = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
            else { return nothing }
            let kinds = (read["kinds"] as? [[String: Any]])?.map { kind in
                Recorded(
                    platform: kind["platform"] as? String ?? "",
                    kind: kind["kind"] as? String ?? "",
                    username: kind["username"] as? String ?? "",
                    accountCards: kind["account_cards"] as? Int)
            }
            return Answer(
                seq: read["seq"] as? Int,
                recordHash: read["record_hash"] as? String,
                ordinal: read["ordinal"] as? Int,
                kinds: kinds,
                mismatches: read["mismatches"] as? [String] ?? [])
        }
    }

    struct Done: Equatable {
        /// The record's date: the challenge's.
        let date: String
        let shortID: String
        /// The list the card signed: what the record states.
        let accounts: [Account]
        /// What the screen said the list would do, before the card signed.
        let expected: [ConsequenceRow]
        /// What the server says it recorded.
        let answer: Answer
        let firstRecord: Bool
        /// When the card's certificate ends, YYMMDDHHMMSS (UTC): step 7
        /// compares it with the reminder's day. Kept nowhere else.
        var notAfter: String? = nil
    }

    /// Bytes to overwrite when they are no longer needed: a certificate, a
    /// signature. They are in memory of this object's own, so `wipe()`
    /// overwrites the one place they are, whoever else is reading them: a
    /// `Data` passed around shares its bytes until one copy is written to,
    /// and overwriting it then only overwrites a new copy.
    private final class Secret {
        private let memory: UnsafeMutableRawBufferPointer

        init(_ bytes: Data) {
            memory = .allocate(byteCount: bytes.count, alignment: 1)
            bytes.copyBytes(to: memory)
        }

        /// The bytes where they are, not a copy: for as long as this object lives.
        var bytes: Data {
            guard let address = memory.baseAddress else { return Data() }
            return Data(bytesNoCopy: address, count: memory.count, deallocator: .none)
        }

        func wipe() {
            memory.initializeMemory(as: UInt8.self, repeating: 0)
        }

        deinit {
            wipe()
            memory.deallocate()
        }
    }

    private let deps: Dependencies
    /// The body of GET /api/v1/config, and its `platforms`.
    private let config: Data
    private let platforms: Data
    private let knownPlatforms: Data
    private(set) var phase = Phase.start

    private var session: DeviceCore.Session?
    private var certificate: Secret?
    private var issuer = ""
    /// When the chosen certificate ends, for step 7's reminder.
    private var notAfter: String?
    /// The CRL downloaded and checked; then that, the tree and the files.
    private var revocation: Task<Void, Error>?
    private var checks: Task<Void, Error>?
    private var files: DeviceCore.ProofFiles?
    private var pin: PIN?
    private var scopeSignature: Secret?
    private var codeSignature: Secret?
    private var cardState: Data?
    private var shortID = ""
    /// The list chosen: what the screen said of it, the list the card signs
    /// and the screen's rows, both as the core takes them.
    private var chosen: (consequence: Consequence, accounts: Data, rows: Data)?
    private var challenge: String?
    private var code: Data?
    private var submission: Data?

    /// `config` is the body of GET /api/v1/config, fetched when the app
    /// opened. Throws `Stop.server` when it has no `platforms`, and with
    /// the code `paused` when it says the operator stopped taking card
    /// proofs (docs/api/card-proof.md): before the card is read.
    /// This card proof's counts (Counts.attempt): the screen sent its first ones.
    private let attempt: Counts.Attempt?
    /// Cancelled by the caller: what fails after it is not counted.
    private var cancelled = false

    init(_ deps: Dependencies, config: Data, attempt: Counts.Attempt? = nil) throws {
        self.deps = deps
        self.config = config
        self.attempt = attempt
        guard let body = try? JSONSerialization.jsonObject(with: config) as? [String: Any],
              let table = body["platforms"],
              let platforms = try? JSONSerialization.data(withJSONObject: table, options: [.fragmentsAllowed]),
              let paused = Self.paused(config)
        else { throw Stop.server(BackendFailure(code: "malformed_response", requestID: nil)) }
        if paused { throw Stop.server(BackendFailure(code: "paused", requestID: nil)) }
        self.platforms = platforms
        knownPlatforms = (try? JSONSerialization.data(withJSONObject: Platform.known.map(\.id))) ?? Data("[]".utf8)
    }

    /// Whether a card proof can start from `config`: it has a table of
    /// platforms and says card proofs are taken. For the count of the step
    /// `config` (spec/counts.md), before the lowest version is read.
    static func takes(_ config: Data) -> Bool {
        guard paused(config) == false, let body = try? JSONSerialization.jsonObject(with: config) as? [String: Any] else { return false }
        return body["platforms"] != nil
    }

    /// `config`'s `paused` (docs/api/card-proof.md): whether the operator
    /// stopped taking card proofs. Absent is false; nil when it is there
    /// and is neither true nor false (spec/device-checks.md:
    /// `malformed_response`), or the body is not an object.
    static func paused(_ config: Data) -> Bool? {
        guard let body = try? JSONSerialization.jsonObject(with: config) as? [String: Any] else { return nil }
        guard let value = body["paused"] else { return false }
        // JSON's true and false, not a number that NSNumber would also read as a Bool.
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// Whether the PIN is in memory: for tests, which cannot see it.
    var holdsPIN: Bool { pin.map { !$0.isEmpty } ?? false }

    // Tap 1 -------------------------------------------------------------------

    /// Reads the card and has the core choose and check its certificate.
    /// Returns the name on it, for the screen before the PIN. The checks
    /// that need no signature go on after it returns (`checksDone`).
    func readCard(_ progress: @escaping (Progress) -> Void) async throws -> String {
        try await counted { try await self.readCardSteps(progress) }
    }

    private func readCardSteps(_ progress: @escaping (Progress) -> Void) async throws -> String {
        try expect(.start)
        var certificates: [Data]
        do {
            certificates = try await deps.card.tap(.readCertificates) { try await $0.certificates() }
        } catch {
            dropped(error, tap: 1)
            let stop = Self.stop(error)
            // Nothing is held yet: a tap that did not happen, was closed or lost the card is made again (Screens.tapsAgain);
            // any other ends the card proof, and step 2 starts a new one.
            if Screens.tapsAgain(stop) { throw stop }
            throw fail(stop)
        }
        defer { for i in certificates.indices { Self.wipe(&certificates[i]) } }
        try live()
        attempt?.step("certificates")
        progress(.certificatesRead)
        do {
            let session = try deps.openSession()
            for certificate in certificates { try session.add(certificate: certificate) }
            var answer = try session.checkCertificates(now: deps.clock())
            defer { Self.wipe(&answer) }
            let result = try Self.object(answer)
            guard result["ok"] as? Bool == true else {
                throw Stop.certificate(
                    problem: result["problem"] as? String ?? "",
                    date: (result["not_after"] ?? result["not_before"]) as? String)
            }
            guard let chosen = result["chosen"] as? Int, certificates.indices.contains(chosen),
                  let name = result["name"] as? String, let issuer = result["issuer"] as? String
            else { throw Stop.core(IDC_ERR_INTERNAL) }
            self.session = session
            self.issuer = issuer
            notAfter = result["not_after"] as? String
            certificate = Secret(certificates[chosen])
            attempt?.step("certificate")
            progress(.certificateChecked)
            phase = .checking
            let revocation = Task { try await self.checkRevocation(session, issuer: issuer) }
            self.revocation = revocation
            checks = Task {
                do {
                    try await revocation.value
                    try await self.buildTree(session, issuer: issuer)
                    // Every check that needs no signature has passed.
                    self.attempt?.step("checked")
                } catch {
                    // Counted when it fails, as on the web page; the flow stops on it when the screen waits for it.
                    if !self.cancelled, self.phase != .stopped, let reason = Counts.reason(of: Self.stop(error)) {
                        self.attempt?.stop(reason)
                    }
                    throw error
                }
            }
            return name
        } catch {
            throw fail(error)
        }
    }

    /// The first of the checks that need no signature: the CRL of the
    /// certificate's issuer, and that the certificate is not on it.
    private func checkRevocation(_ session: DeviceCore.Session, issuer: String) async throws {
        let from = Date()
        let unavailable = Stop.revocation(problem: "crl_unavailable", days: nil)
        guard let index = try? await deps.backend.crlIndex() else { throw unavailable }
        let choice = try Self.object(try session.chooseCRL(index: index))
        guard choice["ok"] as? Bool == true, let sha256 = choice["sha256"] as? String else {
            throw Stop.revocation(problem: choice["problem"] as? String ?? "crl_unavailable", days: nil)
        }
        guard let crl = try? await deps.backend.crl(sha256: sha256) else { throw unavailable }
        let (config, highest) = (config, deps.crlNumbers.highest(for: issuer))
        let checked = try Self.object(try await Self.background { try session.checkCRL(crl, config: config, highest: highest) })
        if let highest = checked["highest_after"] as? String { deps.crlNumbers.remember(highest, for: issuer) }
        guard checked["ok"] as? Bool == true else {
            throw Stop.revocation(problem: checked["problem"] as? String ?? "crl_unavailable", days: checked["days"] as? Int)
        }
        attempt?.took("crl", seconds: Date().timeIntervalSince(from))
        attempt?.step("crl")
    }

    /// The rest of them, while the cardholder types the PIN: the tree and
    /// the certificate's path in it, and the files a proof needs.
    private func buildTree(_ session: DeviceCore.Session, issuer: String) async throws {
        let from = Date()
        try await Self.background { try session.buildTree() }
        attempt?.took("tree", seconds: Date().timeIntervalSince(from))
        attempt?.step("tree")
        let files = try deps.proofFiles(issuer)
        do {
            try await Self.background { try session.checkArtifacts(files) }
        } catch let failure as DeviceCore.Failure where failure.code == IDC_ERR_INPUT {
            throw Stop.artifact
        }
        // The files are the ones written into the core, which proves with them.
        attempt?.step("circuit")
        attempt?.step("engine")
        // A flow cancelled meanwhile keeps nothing.
        try live()
        self.files = files
    }

    /// Returns when the CRL passed and the certificate is not on it;
    /// throws why not, and the flow stops. The other checks go on.
    func revocationChecked() async throws {
        try await counted { try await self.revocationCheckedSteps() }
    }

    private func revocationCheckedSteps() async throws {
        try expect(.checking)
        do {
            try await revocation?.value
        } catch {
            throw fail(error)
        }
        try live()
    }

    /// Returns when every check that needs no signature has passed; throws
    /// the first that did not, and the flow stops.
    func checksDone() async throws {
        try await counted { try await self.checksDoneSteps() }
    }

    private func checksDoneSteps() async throws {
        try expect(.checking)
        do {
            try await checks?.value
        } catch {
            throw fail(error)
        }
        try live()
    }

    // Tap 2 -------------------------------------------------------------------

    /// The card signs the scope string; the scoped ID; the card's state.
    /// A wrong PIN, another card, no card or a card that left leaves the
    /// step to be done again: with the same PIN where it did not go to a
    /// card that may have counted it wrong, with a PIN typed again otherwise.
    /// `signed` is called when the card has signed and can be taken away.
    func confirmCard(pin: PIN, signed: () -> Void) async throws -> CardStatus {
        attempt?.step("pin")
        return try await counted { try await self.confirmCardSteps(pin: pin, signed: signed) }
    }

    private func confirmCardSteps(pin: PIN, signed: () -> Void) async throws -> CardStatus {
        // Whatever stops it before the tap: the PIN is not kept.
        do {
            try await checksDone()
        } catch {
            pin.clear()
            throw error
        }
        guard let session else {
            pin.clear()
            throw fail(Stop.state)
        }
        let scope: Data
        do {
            scope = try DeviceCore.scopeString(deps.proofLog)
        } catch {
            pin.clear()
            throw fail(error)
        }
        var signature: Data
        do {
            signature = try await signTap(scope, pin: pin, tap: 2)
        } catch CardFailure.pinIncorrect {
            // The PIN is not the card's: it is not kept.
            pin.clear()
            throw Stop.card(.pinIncorrect)
        } catch CardFailure.channel {
            // The PIN went nowhere, but it is typed again all the same: the
            // phone could not talk to this card, and the screen says to use
            // a computer instead.
            pin.clear()
            throw Stop.card(.channel)
        } catch let failure as CardFailure where Self.tapCanBeMadeAgain(failure) || (failure == .dropped(.sent) && pin.accepted) {
            // The PIN did not go to a card that may have counted it wrong
            // (it never went, or the card has accepted it): it is the
            // caller's still, for the same tap again.
            if failure == .dropped(.accepted) { pin.accepted = true }
            throw Stop.card(failure == .dropped(.sent) ? .dropped(.accepted) : failure)
        } catch CardFailure.dropped(.sent) {
            // The card left while the PIN was going to it, and has never
            // accepted this PIN: whether it counted a try is not known.
            // Not sent again by itself; the cardholder types it again
            // (issue #133).
            pin.clear()
            throw Stop.card(.dropped(.sent))
        } catch {
            pin.clear()
            throw fail(error)
        }
        do {
            try live()
            signed()
            let body: Data
            do {
                body = try session.cardStateRequest(now: deps.clock(), scopeSignature: signature)
            } catch let failure as DeviceCore.Failure where failure.code == IDC_ERR_INPUT {
                throw Stop.cardSignature
            }
            pin.accepted = true
            self.pin = pin
            scopeSignature = Secret(signature)
            Self.wipe(&signature)
            guard let scopedID = try Self.object(body)["scoped_id"] as? String else { throw Stop.core(IDC_ERR_INTERNAL) }
            shortID = try DeviceCore.shortID(of: scopedID)
            attempt?.step("scope_signed")
            return try await cardStateNow(body)
        } catch let away as TurnedAway {
            // The card signed, the PIN is kept for tap 3: retryCardState() asks again.
            throw Stop.server(away.failure)
        } catch {
            Self.wipe(&signature)
            pin.clear()
            throw fail(error)
        }
    }

    /// The card's state asked again, after the server turned it away as
    /// too many (confirmCard): the card signed already and the PIN is
    /// kept, so nothing is signed again.
    func retryCardState() async throws -> CardStatus {
        try await counted { try await self.retryCardStateSteps() }
    }

    private func retryCardStateSteps() async throws -> CardStatus {
        try expect(.cardStateTurnedAway)
        do {
            guard let session, let scopeSignature else { throw Stop.state }
            try stillValid(at: deps.clock())
            let body = try session.cardStateRequest(now: deps.clock(), scopeSignature: scopeSignature.bytes)
            return try await cardStateNow(body)
        } catch let away as TurnedAway {
            throw Stop.server(away.failure)
        } catch {
            throw fail(error)
        }
    }

    /// The server turned a request away as too many people
    /// (docs/api/card-proof.md, "Rules for every endpoint"): the card proof
    /// does not end, and the same request can be sent again.
    private struct TurnedAway: Error {
        let failure: BackendFailure
    }

    /// The card's state, asked of the server with the scoped ID. Turned
    /// away as too many, the flow waits in `cardStateTurnedAway`.
    private func cardStateNow(_ body: Data) async throws -> CardStatus {
        let state: Data
        do {
            state = try await deps.backend.cardState(body)
        } catch let failure as BackendFailure where failure.tooMany {
            try live()
            phase = .cardStateTurnedAway
            throw TurnedAway(failure: failure)
        }
        try live()
        let status = try status(of: state)
        cardState = state
        phase = .statusKnown
        attempt?.step("state")
        return status
    }

    /// A tap with the PIN that ended without the PIN having gone to a card
    /// that did not accept it: the same tap can be made again with the PIN
    /// in memory. Another card than the one read, no card, the panel
    /// closed, the card gone before the PIN was sent or after it had
    /// accepted it.
    private static func tapCanBeMadeAgain(_ failure: CardFailure) -> Bool {
        switch failure {
        case .otherCard, .noTap, .cancelled, .dropped(.notSent), .dropped(.accepted): return true
        default: return false
        }
    }

    /// One tap with the PIN: the card must hold the certificate chosen in
    /// tap 1, or the PIN is not sent.
    private func signTap(_ message: Data, pin: PIN, tap: Int) async throws -> Data {
        guard let certificate else { throw Stop.state }
        do {
            return try await deps.card.tap(.sign) { connection in
                var now = try await connection.certificates()
                defer { for i in now.indices { Self.wipe(&now[i]) } }
                guard now.contains(where: { $0 == certificate.bytes }) else { throw CardFailure.otherCard }
                return try await connection.sign(message, pin: pin)
            }
        } catch {
            dropped(error, tap: tap, pinAccepted: pin.accepted)
            throw error
        }
    }

    /// A card that left during tap `tap` is an action, not a reason (spec/counts.md, "Actions of a card proof"); but
    /// one that left while a PIN the card never accepted was going to it is the reason `pin_maybe_received`, and not
    /// this action as well.
    private func dropped(_ error: Error, tap: Int, pinAccepted: Bool = false) {
        guard case CardFailure.dropped(let fate) = error, fate != .sent || pinAccepted else { return }
        attempt?.tapDropped(tap)
    }

    /// Runs a step of the flow, and tells the counts why it failed: as
    /// `stop` if the flow stopped, as `retry` if the step can be done again.
    private func counted<T>(_ step: () async throws -> T) async throws -> T {
        do {
            return try await step()
        } catch {
            count(error)
            throw error
        }
    }

    private func count(_ error: Error) {
        // Cancelled by the caller, or a call refused as out of order: nothing changed, nothing to count.
        guard !cancelled, let stop = error as? Stop, stop != .state, let reason = Counts.reason(of: stop) else { return }
        // Tap 3 lost the card while the PIN, accepted at tap 2, was going to it: the action was counted, and is no reason.
        if stop == .card(.dropped(.sent)), pin?.accepted == true { return }
        if phase == .stopped { attempt?.stop(reason) } else { attempt?.retry(reason) }
    }

    /// The card's state as the core reads it, for the screen.
    private func status(of state: Data) throws -> CardStatus {
        let answer: Data
        do {
            answer = try DeviceCore.cardStatus(platforms: platforms, cardState: state, knownPlatforms: knownPlatforms, now: deps.clock())
        } catch let failure as DeviceCore.Failure where failure.code == IDC_ERR_INPUT {
            // The table or the state cannot be read: no list can be built from it.
            throw Stop.server(BackendFailure(code: "malformed_response", requestID: nil))
        }
        let status = try Self.object(answer)
        let rows = (status["rows"] as? [[String: Any]] ?? []).map { row in
            StatusRow(
                platform: row["platform"] as? String ?? "",
                known: row["known"] as? Bool ?? false,
                current: row["current"] as? String,
                lastDeclared: row["last_declared"] as? String,
                switchCount: row["switch_count"] as? Int ?? 0,
                switchesLeft: row["switches_left"] as? Int ?? 0)
        }
        return CardStatus(
            shortID: shortID,
            lastCardProof: status["last_card_proof"] as? String,
            daysSince: status["days_since"] as? Int,
            dailyLimit: status["daily_limit"] as? Bool ?? false,
            knownPlatforms: status["known_platforms"] as? [String] ?? [],
            rows: rows)
    }

    // The cardholder edits the list; nothing is signed or sent ------------------

    /// What the list `entries` makes would do: for every platform offered,
    /// the account typed, or "" for none. A list that is not possible, or
    /// an account not in its platform's format, throws without stopping
    /// the flow: the cardholder changes the list again.
    func choose(_ entries: [String: String]) throws -> Consequence {
        guard phase == .statusKnown || phase == .chosen else { throw Stop.state }
        let (consequence, accounts, rows): (Consequence, Data, Data)
        do {
            (consequence, accounts, rows) = try self.consequence(of: entries)
        } catch {
            count(error)
            throw error
        }
        chosen = (consequence, accounts, rows)
        phase = .chosen
        attempt?.step("chosen")
        return consequence
    }

    /// Whether `typed`, tidied, is an account in the format of
    /// `platform`: throws `Stop.username` when it is not. For the preview
    /// of an account's page, before the list is confirmed.
    func checkFormat(of typed: String, on platform: String) throws {
        do {
            _ = try consequence(of: [platform: typed])
        } catch Stop.blocked {
            // The rules are for the whole list, when it is confirmed.
        }
    }

    /// Back from the consequence to the card's state.
    func back() throws {
        guard phase == .statusKnown || phase == .chosen else { throw Stop.state }
        chosen = nil
        phase = .statusKnown
    }

    /// The core's answer for `entries` on today's date, with the list the
    /// card signs and the rows written again as JSON, for the core to
    /// take.
    private func consequence(of entries: [String: String]) throws -> (Consequence, Data, Data) {
        guard let cardState else { throw Stop.state }
        let list = entries.keys.sorted().compactMap { platform -> [String: String]? in
            let typed = entries[platform] ?? ""
            let username = Platform.of(platform)?.tidy(typed) ?? typed
            return username.isEmpty ? nil : ["platform": platform, "username": username]
        }
        let now = deps.clock()
        let answer: [String: Any]
        do {
            let json = try JSONSerialization.data(withJSONObject: list)
            answer = try Self.object(try DeviceCore.listConsequence(platforms: platforms, cardState: cardState, knownPlatforms: knownPlatforms, accounts: json, now: now))
        } catch {
            throw Self.stop(error)
        }
        guard answer["valid"] as? Bool == true else {
            let platform = answer["platform"] as? String
            if answer["reason"] as? String == "username", let platform { throw Stop.username(platform: platform) }
            throw Stop.blocked(reason: answer["reason"] as? String ?? "", platform: platform)
        }
        guard let signed = answer["accounts"] as? [[String: String]],
              let accounts = try? JSONSerialization.data(withJSONObject: signed, options: [.sortedKeys])
        else { throw Stop.core(IDC_ERR_INTERNAL) }
        guard let written = answer["rows"] as? [[String: Any]],
              let rowsJSON = try? JSONSerialization.data(withJSONObject: written, options: [.sortedKeys])
        else { throw Stop.core(IDC_ERR_INTERNAL) }
        let rows = written.map { row in
            ConsequenceRow(
                platform: row["platform"] as? String ?? "",
                known: row["known"] as? Bool ?? false,
                kind: row["kind"] as? String ?? "",
                username: row["username"] as? String ?? "",
                current: row["current"] as? String,
                previous: row["previous"] as? String,
                switchesLeft: row["switches_left"] as? Int)
        }
        let consequence = Consequence(
            accounts: signed.map { Account(platform: $0["platform"] ?? "", username: $0["username"] ?? "") },
            rows: rows,
            firstRecord: answer["first_record"] as? Bool ?? false,
            today: Self.dateInTaiwan(now))
        return (consequence, accounts, rowsJSON)
    }

    // Tap 3, the proof, the submission ---------------------------------------------

    /// Before tap 3: the certificate and the CRL still pass on today's
    /// date, a challenge, and the list still does on every platform what
    /// the screen said.
    func prepare() async throws {
        try await counted { try await self.prepareSteps() }
    }

    private func prepareSteps() async throws {
        try expect(.chosen)
        attempt?.step("confirmed")
        let challenge: String
        // What the list does is not worked out again after midnight: since
        // version 3 of the record rules (ADR-0018) no event rule reads the
        // date, and a new day only lifts the day's limit.
        do {
            try stillValid(at: deps.clock())
            challenge = try await deps.backend.challenge()
        } catch let failure as BackendFailure where failure.tooMany {
            // Too many people: nothing was signed, the PIN is kept, and the
            // flow is where it was; prepare() asks for a challenge again.
            do { try live() } catch { throw fail(error) }
            throw Stop.server(failure)
        } catch {
            throw fail(error)
        }
        do {
            try live()
            // The record is dated the challenge's date, and the core makes a
            // proof only for a challenge it took: dated today in Taiwan, in
            // its one spelling. Another stops here, before the PIN goes to
            // the card. Midnight may have passed while the server answered:
            // the core then checks the date conditions again too.
            guard let session else { throw Stop.state }
            let taken = try Self.object(try session.checkChallenge(now: deps.clock(), challenge: Data(challenge.utf8)))
            if taken["ok"] as? Bool != true {
                switch taken["problem"] as? String {
                case "challenge_malformed": throw Stop.server(BackendFailure(code: "challenge_malformed", requestID: nil))
                case "challenge_not_today": throw Stop.challengeNotToday
                default: throw Self.dateStop(taken)
                }
            }
            guard let chosen else { throw Stop.state }
            code = try DeviceCore.declarationCode(deps.proofLog, accounts: chosen.accounts, challenge: Data(challenge.utf8))
            self.challenge = challenge
            phase = .readyToSign
            attempt?.step("challenge")
        } catch {
            throw fail(error)
        }
    }

    /// The card signs the declaration code. Another card than the one of
    /// tap 1, no card, or a card that left leaves the step to be done
    /// again, with the PIN in memory.
    func sign() async throws {
        try await counted { try await self.signSteps() }
    }

    private func signSteps() async throws {
        try expect(.readyToSign)
        guard let pin, let code else { throw fail(Stop.state) }
        do {
            var signature = try await signTap(code, pin: pin, tap: 3)
            codeSignature = Secret(signature)
            Self.wipe(&signature)
        } catch let failure as CardFailure where Self.tapCanBeMadeAgain(failure) || failure == .dropped(.sent) {
            // The card accepted this PIN in tap 2: wherever this tap lost
            // the card, the PIN is sent again with the next (issue #133).
            throw Stop.card(failure)
        } catch {
            throw fail(error)
        }
        // The second signature is made: the PIN is not needed again.
        pin.clear()
        self.pin = nil
        do { try live() } catch { throw fail(error) }
        phase = .signed
        attempt?.step("code_signed")
    }

    /// The proof and the record's fields, made by the core. The
    /// certificate and the signatures are overwritten when it returns.
    func prove() async throws {
        try await counted { try await self.proveSteps() }
    }

    private func proveSteps() async throws {
        try expect(.signed)
        guard let session, let files, let chosen, let challenge, let scopeSignature, let codeSignature else { throw fail(Stop.state) }
        let from = Date()
        do {
            let accounts = chosen.accounts
            let body: Data
            do {
                body = try await Self.background {
                    try session.recordsRequest(files, accounts: accounts, challenge: Data(challenge.utf8), scopeSignature: scopeSignature.bytes, declarationCodeSignature: codeSignature.bytes)
                }
            } catch let failure as DeviceCore.Failure where failure.code == IDC_ERR_INPUT {
                throw Stop.cardSignature
            }
            try live()
            // The proof holds everything the server needs.
            dropSecrets()
            submission = body
            phase = .submitting
            attempt?.took("proved", seconds: Date().timeIntervalSince(from))
            attempt?.step("proved")
        } catch {
            throw fail(error)
        }
    }

    /// Sends the record. After `Stop.server` with the code `network`, or
    /// one the server turned away as too many, it can be sent again as it is.
    func submit() async throws -> Done {
        try await counted { try await self.submitSteps() }
    }

    private func submitSteps() async throws -> Done {
        guard phase == .submitting || phase == .submitFailed else { throw Stop.state }
        guard let submission, let chosen, let challenge else { throw fail(Stop.state) }
        // The same record again, after a submission that did not get through.
        if phase == .submitFailed { attempt?.resubmitted() }
        phase = .submitting
        let response: Data
        do {
            response = try await deps.backend.submit(deps.counts?.deviceID().map { Self.withDeviceID(submission, $0) } ?? submission)
        } catch let failure as BackendFailure where failure.code == "network" || failure.tooMany {
            try live()
            phase = .submitFailed
            throw Stop.server(failure)
        } catch {
            throw fail(error)
        }
        do { try live() } catch { throw fail(error) }
        phase = .done
        self.submission = nil
        attempt?.step("done")
        return Done(
            date: String(challenge.prefix(10)),
            shortID: shortID,
            accounts: chosen.consequence.accounts,
            expected: chosen.consequence.rows,
            answer: Answer.read(response, rows: chosen.rows),
            firstRecord: chosen.consequence.firstRecord,
            notAfter: notAfter)
    }

    /// Drops everything. The flow cannot continue.
    func cancel() {
        cancelled = true
        end()
    }

    /// The submission `body`, the core's, carrying the card proof device ID
    /// (docs/api/card-proof.md, `device_id`): a member the server writes in
    /// the connection log and nowhere else (ADR-0022, ADR-0039).
    nonisolated static func withDeviceID(_ body: Data, _ id: String) -> Data {
        guard body.count > 2, body.first == UInt8(ascii: "{"), id.utf8.count == 32, id.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }) else { return body }
        return Data("{\"device_id\":\"\(id)\",".utf8) + body.dropFirst()
    }

    // ---------------------------------------------------------------------------

    /// The certificate is still valid and the CRL no older than its bound,
    /// on the date of `now`: a card proof can cross midnight.
    private func stillValid(at now: Date) throws {
        guard let session else { throw Stop.state }
        let answer = try Self.object(try session.checkDate(now: now))
        guard answer["ok"] as? Bool == true else { throw Self.dateStop(answer) }
    }

    /// Why the date conditions did not hold: the answer of the core's
    /// checkDate, or of checkChallenge after midnight.
    private static func dateStop(_ answer: [String: Any]) -> Stop {
        let problem = answer["problem"] as? String ?? ""
        if problem == "crl_stale" { return Stop.revocation(problem: problem, days: answer["days"] as? Int) }
        return Stop.certificate(problem: problem, date: (answer["not_after"] ?? answer["not_before"]) as? String)
    }

    private func expect(_ phase: Phase) throws {
        guard self.phase == phase else { throw Stop.state }
    }

    /// After every wait: a flow that was cancelled meanwhile goes no further.
    private func live() throws {
        if phase == .stopped { throw Stop.state }
    }

    /// Stops the flow, drops everything, and gives the reason to throw.
    private func fail(_ error: Error) -> Stop {
        end()
        return Self.stop(error)
    }

    private func end() {
        phase = .stopped
        revocation?.cancel()
        checks?.cancel()
        revocation = nil
        checks = nil
        dropSecrets()
        cardState = nil
        chosen = nil
        challenge = nil
        code = nil
        submission = nil
        notAfter = nil
    }

    /// The PIN, the certificate, the signatures, and the core's session
    /// with its own copies.
    private func dropSecrets() {
        pin?.clear()
        pin = nil
        certificate?.wipe()
        scopeSignature?.wipe()
        codeSignature?.wipe()
        certificate = nil
        scopeSignature = nil
        codeSignature = nil
        files = nil
        session = nil
    }

    private static func stop(_ error: Error) -> Stop {
        switch error {
        case let stop as Stop: return stop
        case let failure as CardFailure: return .card(failure)
        case let failure as BackendFailure: return .server(failure)
        case let failure as DeviceCore.Failure: return .core(failure.code)
        default: return .core(IDC_ERR_INTERNAL)
        }
    }

    private static func object(_ json: Data) throws -> [String: Any] {
        guard let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { throw Stop.core(IDC_ERR_INTERNAL) }
        return object
    }

    /// Overwrites the bytes with zeros.
    private static func wipe(_ data: inout Data) {
        data.resetBytes(in: 0..<data.count)
    }

    /// Runs `work`, which blocks while the core computes, off the main thread.
    private static func background<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await Task.detached(priority: .userInitiated, operation: work).value
    }

    /// The date in Taiwan (UTC+8), YYYY-MM-DD.
    nonisolated static func dateInTaiwan(_ time: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600) ?? .current
        let day = calendar.dateComponents([.year, .month, .day], from: time)
        return String(format: "%04d-%02d-%02d", day.year ?? 0, day.month ?? 0, day.day ?? 0)
    }
}
