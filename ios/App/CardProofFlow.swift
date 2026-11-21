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
///   choose(entries)   the account typed on each platform offered: the list
///                     the card would sign and what it does (the core
///                     computes it). No request, no signature
///   back()            from the consequence to the card's state again
///   prepare()         the date conditions again; a challenge, dated today;
///                     the list still does what the screen said; the
///                     declaration code
///   sign()            tap 3: the card signs the declaration code; the PIN
///                     is cleared
///   prove()           the proof, made by the core; the certificate and the
///                     signatures are overwritten
///   submit()          the record goes to the server; again after a
///                     failure, as it is
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
///   failures         thrown to the caller only; no request carries them
@MainActor
final class CardProofFlow {
    struct Dependencies {
        /// Which roster's scope string the card signs: fixed by the build.
        var roster: DeviceCore.Roster
        var backend: Backend
        var card: Card
        /// The device's clock.
        var clock: () -> Date
        var crlNumbers: CRLNumbers
        /// Opens the core's session: one that checks against MOICA's keys.
        var openSession: () throws -> DeviceCore.Session
        /// The files a proof needs, for the issuer of the certificate (G2, G3).
        var proofFiles: (_ issuer: String) throws -> DeviceCore.ProofFiles
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
        /// The list is not possible by the roster rules: `empty`,
        /// `daily_limit`, or `switch_limit` on `platform`.
        case blocked(reason: String, platform: String?)
        /// The challenge is not dated today in Taiwan by the device's
        /// clock. Nothing was signed.
        case challengeNotToday
        /// The date changed since the list was confirmed, and the list
        /// would now do something else. Nothing was signed.
        case dateChanged
        /// A step called out of order.
        case state
    }

    /// What tap 1 has done, for the screen's list.
    enum Progress: Equatable {
        case certificatesRead
        case certificateChecked
    }

    enum Phase: Equatable {
        case start, checking, statusKnown, chosen, readyToSign, signed, submitting, submitFailed, done, stopped
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
        let correctionToday: Bool
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

    struct Done: Equatable {
        /// The record's date: the challenge's.
        let date: String
        let shortID: String
        /// The list the card signed: what the record states.
        let accounts: [Account]
        /// What the screen said the list would do, before the card signed.
        let rows: [ConsequenceRow]
        let firstRecord: Bool
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
    /// The CRL downloaded and checked; then that, the tree and the files.
    private var revocation: Task<Void, Error>?
    private var checks: Task<Void, Error>?
    private var files: DeviceCore.ProofFiles?
    private var pin: PIN?
    private var scopeSignature: Secret?
    private var codeSignature: Secret?
    private var cardState: Data?
    private var shortID = ""
    private var entries: [String: String]?
    private var chosen: (consequence: Consequence, accounts: Data)?
    private var challenge: String?
    private var code: Data?
    private var submission: Data?

    /// `config` is the body of GET /api/v1/config, fetched when the app
    /// opened. Throws `Stop.server` when it has no `platforms`.
    init(_ deps: Dependencies, config: Data) throws {
        self.deps = deps
        self.config = config
        guard let body = try? JSONSerialization.jsonObject(with: config) as? [String: Any],
              let table = body["platforms"],
              let platforms = try? JSONSerialization.data(withJSONObject: table, options: [.fragmentsAllowed])
        else { throw Stop.server(BackendFailure(code: "malformed_response", requestID: nil)) }
        self.platforms = platforms
        knownPlatforms = (try? JSONSerialization.data(withJSONObject: Platform.known.map(\.id))) ?? Data("[]".utf8)
    }

    /// Whether the PIN is in memory: for tests, which cannot see it.
    var holdsPIN: Bool { pin.map { !$0.isEmpty } ?? false }

    // Tap 1 -------------------------------------------------------------------

    /// Reads the card and has the core choose and check its certificate.
    /// Returns the name on it, for the screen before the PIN. The checks
    /// that need no signature go on after it returns (`checksDone`).
    func readCard(_ progress: @escaping (Progress) -> Void) async throws -> String {
        try expect(.start)
        var certificates: [Data]
        do {
            certificates = try await deps.card.tap(.readCertificates) { try await $0.certificates() }
        } catch {
            // Nothing is held yet: the same step can be done again.
            throw Self.stop(error)
        }
        defer { for i in certificates.indices { Self.wipe(&certificates[i]) } }
        try live()
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
            certificate = Secret(certificates[chosen])
            progress(.certificateChecked)
            phase = .checking
            let revocation = Task { try await self.checkRevocation(session, issuer: issuer) }
            self.revocation = revocation
            checks = Task {
                try await revocation.value
                try await self.buildTree(session, issuer: issuer)
            }
            return name
        } catch {
            throw fail(error)
        }
    }

    /// The first of the checks that need no signature: the CRL of the
    /// certificate's issuer, and that the certificate is not on it.
    private func checkRevocation(_ session: DeviceCore.Session, issuer: String) async throws {
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
    }

    /// The rest of them, while the cardholder types the PIN: the tree and
    /// the certificate's path in it, and the files a proof needs.
    private func buildTree(_ session: DeviceCore.Session, issuer: String) async throws {
        try await Self.background { try session.buildTree() }
        let files = try deps.proofFiles(issuer)
        do {
            try await Self.background { try session.checkArtifacts(files) }
        } catch let failure as DeviceCore.Failure where failure.code == IDC_ERR_INPUT {
            throw Stop.artifact
        }
        // A flow cancelled meanwhile keeps nothing.
        try live()
        self.files = files
    }

    /// Returns when the CRL passed and the certificate is not on it;
    /// throws why not, and the flow stops. The other checks go on.
    func revocationChecked() async throws {
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
    /// A wrong PIN or another card leaves the step to be done again.
    /// `signed` is called when the card has signed and can be taken away.
    func confirmCard(pin: PIN, signed: () -> Void) async throws -> CardStatus {
        try await checksDone()
        guard let session else { throw fail(Stop.state) }
        let scope: Data
        do {
            scope = try DeviceCore.scopeString(deps.roster)
        } catch {
            throw fail(error)
        }
        var signature: Data
        do {
            signature = try await signTap(scope, pin: pin)
        } catch CardFailure.pinIncorrect {
            // The PIN is not the card's: it is not kept.
            pin.clear()
            throw Stop.card(.pinIncorrect)
        } catch CardFailure.otherCard {
            // The PIN went nowhere.
            throw Stop.card(.otherCard)
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
            self.pin = pin
            scopeSignature = Secret(signature)
            Self.wipe(&signature)
            guard let scopedID = try Self.object(body)["scoped_id"] as? String else { throw Stop.core(IDC_ERR_INTERNAL) }
            shortID = try DeviceCore.shortID(of: scopedID)
            let state = try await deps.backend.cardState(body)
            try live()
            let status = try status(of: state)
            cardState = state
            phase = .statusKnown
            return status
        } catch {
            Self.wipe(&signature)
            pin.clear()
            throw fail(error)
        }
    }

    /// One tap with the PIN: the card must hold the certificate chosen in
    /// tap 1, or the PIN is not sent.
    private func signTap(_ message: Data, pin: PIN) async throws -> Data {
        guard let certificate else { throw Stop.state }
        return try await deps.card.tap(.sign) { connection in
            var now = try await connection.certificates()
            defer { for i in now.indices { Self.wipe(&now[i]) } }
            guard now.contains(where: { $0 == certificate.bytes }) else { throw CardFailure.otherCard }
            return try await connection.sign(message, pin: pin)
        }
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
                switchesLeft: row["switches_left"] as? Int ?? 0,
                correctionToday: row["correction_today"] as? Bool ?? false)
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
        let (consequence, accounts) = try consequence(of: entries)
        self.entries = entries
        chosen = (consequence, accounts)
        phase = .chosen
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
        entries = nil
        phase = .statusKnown
    }

    /// The core's answer for `entries` on today's date, and the list the
    /// card signs as the core wrote it.
    private func consequence(of entries: [String: String]) throws -> (Consequence, Data) {
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
        let rows = (answer["rows"] as? [[String: Any]] ?? []).map { row in
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
        return (consequence, accounts)
    }

    // Tap 3, the proof, the submission ---------------------------------------------

    /// Before tap 3: the certificate and the CRL still pass on today's
    /// date, a challenge, and the list still does on every platform what
    /// the screen said.
    func prepare() async throws {
        try expect(.chosen)
        do {
            try sameAsShown()
            try stillValid(at: deps.clock())
            let challenge = try await deps.backend.challenge()
            try live()
            // The record is dated the challenge's date, and the core makes a
            // proof only for the date its checks hold for: a challenge of
            // another date stops here, before the PIN goes to the card.
            // One reading of the clock for both: midnight may have passed
            // while the server answered.
            let now = deps.clock()
            guard challenge.prefix(10) == Self.dateInTaiwan(now) else { throw Stop.challengeNotToday }
            try stillValid(at: now)
            try sameAsShown()
            guard let chosen else { throw Stop.state }
            do {
                code = try DeviceCore.declarationCode(deps.roster, accounts: chosen.accounts, challenge: Data(challenge.utf8))
            } catch let failure as DeviceCore.Failure where failure.code == IDC_ERR_INPUT {
                throw Stop.server(BackendFailure(code: "challenge_malformed", requestID: nil))
            }
            self.challenge = challenge
            phase = .readyToSign
        } catch {
            throw fail(error)
        }
    }

    /// The card signs the declaration code. Another card than the one of
    /// tap 1 leaves the step to be done again; the PIN was not sent.
    func sign() async throws {
        try expect(.readyToSign)
        guard let pin, let code else { throw fail(Stop.state) }
        do {
            var signature = try await signTap(code, pin: pin)
            codeSignature = Secret(signature)
            Self.wipe(&signature)
        } catch CardFailure.otherCard {
            throw Stop.card(.otherCard)
        } catch {
            throw fail(error)
        }
        // The second signature is made: the PIN is not needed again.
        pin.clear()
        self.pin = nil
        do { try live() } catch { throw fail(error) }
        phase = .signed
    }

    /// The proof and the record's fields, made by the core. The
    /// certificate and the signatures are overwritten when it returns.
    func prove() async throws {
        try expect(.signed)
        guard let session, let files, let chosen, let challenge, let scopeSignature, let codeSignature else { throw fail(Stop.state) }
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
        } catch {
            throw fail(error)
        }
    }

    /// Sends the record. After `Stop.server` with the code `network`, it
    /// can be sent again as it is.
    func submit() async throws -> Done {
        guard phase == .submitting || phase == .submitFailed else { throw Stop.state }
        guard let submission, let chosen, let challenge else { throw fail(Stop.state) }
        phase = .submitting
        do {
            try await deps.backend.submit(submission)
        } catch let failure as BackendFailure where failure.code == "network" {
            try live()
            phase = .submitFailed
            throw Stop.server(failure)
        } catch {
            throw fail(error)
        }
        do { try live() } catch { throw fail(error) }
        phase = .done
        self.submission = nil
        return Done(
            date: String(challenge.prefix(10)),
            shortID: shortID,
            accounts: chosen.consequence.accounts,
            rows: chosen.consequence.rows,
            firstRecord: chosen.consequence.firstRecord)
    }

    /// Drops everything. The flow cannot continue.
    func cancel() {
        end()
    }

    // ---------------------------------------------------------------------------

    /// The certificate is still valid and the CRL no older than its bound,
    /// on the date of `now`: a card proof can cross midnight.
    private func stillValid(at now: Date) throws {
        guard let session else { throw Stop.state }
        let answer = try Self.object(try session.checkDate(now: now))
        guard answer["ok"] as? Bool == true else {
            let problem = answer["problem"] as? String ?? ""
            if problem == "crl_stale" { throw Stop.revocation(problem: problem, days: answer["days"] as? Int) }
            throw Stop.certificate(problem: problem, date: (answer["not_after"] ?? answer["not_before"]) as? String)
        }
    }

    /// The chosen list, worked out again on today's date: it must do on
    /// every platform what the screen said.
    private func sameAsShown() throws {
        guard let entries, let chosen else { throw Stop.state }
        let again: Consequence
        do {
            again = try consequence(of: entries).0
        } catch Stop.blocked {
            throw Stop.dateChanged
        }
        guard again.accounts == chosen.consequence.accounts else { throw Stop.state }
        guard again.rows == chosen.consequence.rows else { throw Stop.dateChanged }
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
        entries = nil
        challenge = nil
        code = nil
        submission = nil
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
