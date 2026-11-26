import Foundation
import Security
import UIKit

/// The counts of the app's card proofs (spec/counts.md; ADR-0032,
/// ADR-0039): which step a card proof reached, why it stopped or must be
/// tried again, a card that left during a tap, the record sent again, how
/// long the CRL, the tree and the proof took. One request to
/// POST /api/v1/counts for each, whose answer nobody reads.
///
/// - Every value is a code of the table, chosen here (`reason(of:)`), or a
///   random ID, or one of three values of the phone's system: its version,
///   the app's version, the phone's model (`Dependencies`). The core builds
///   the body (`DeviceCore.count`) by the table the server reads with: a
///   version or a model not in its format is left out, and a count the
///   server would drop is not sent. Nothing of a failure but its code: no
///   text of an error, the card or the server. No account, no scoped ID,
///   nothing read from the card.
/// - The card proof device ID is 16 random bytes kept in the app's own
///   user defaults with the date it was made on, in Taiwan; 31 days after
///   that date it is replaced, and the old one is not kept anywhere
///   (`deviceID()`, the core's rule). The submission of a record carries
///   it too. The attempt ID is 16 random bytes kept in memory by one card
///   proof (`Attempt`), and dropped with it.
/// - Sending never holds a card proof up: `send` does not wait, and a
///   request that fails is not sent again.
@MainActor
final class Counts {
    struct Dependencies {
        /// Sends a body to POST /api/v1/counts, off the caller's way; one
        /// that fails is not sent again, and is nobody's failure.
        var send: (Data) -> Void
        /// The device's clock.
        var clock: () -> Date
        /// `count` bytes from the device's random source.
        var random: (Int) -> Data
        /// The value the card proof device ID is kept as: `<ID>.<the date it was made on>`.
        var stored: () -> String?
        var store: (String) -> Void
        /// The system's version as it gives it (`UIDevice.current.systemVersion`).
        var osVersion: String
        /// The version the store shows (`CFBundleShortVersionString`).
        var appVersion: String
        /// The phone's model as its system gives it (`utsname.machine`),
        /// never a name its owner gave it.
        var model: String
    }

    private let deps: Dependencies

    init(_ deps: Dependencies) {
        self.deps = deps
    }

    /// The card proof device ID today, by the core's rule (spec/counts.md,
    /// "The card proof device ID"): the stored one if it was made fewer
    /// than 31 days ago in Taiwan, otherwise a new one, written over the
    /// old. Nil when none can be had (a clock the core does not take).
    func deviceID() -> String? {
        var random = deps.random(16)
        defer { random.resetBytes(in: 0..<random.count) }
        guard let answer = try? DeviceCore.countDeviceID(stored: Data((deps.stored() ?? "").utf8), now: deps.clock(), random: random),
              let object = try? JSONSerialization.jsonObject(with: answer) as? [String: Any],
              let id = object["device_id"] as? String
        else { return nil }
        if let store = object["store"] as? String { deps.store(store) }
        return id
    }

    /// The counts of one card proof, under a new attempt ID.
    func attempt() -> Attempt {
        Attempt(counts: self, id: deps.random(16).map { String(format: "%02x", $0) }.joined())
    }

    /// False when there is nothing to send: the core says the server would drop it.
    fileprivate func send(_ members: [String: String], attempt id: String) -> Bool {
        guard let device = deviceID() else { return false }
        var count = members
        count["client"] = "ios"
        count["device_id"] = device
        count["attempt_id"] = id
        count["os_version"] = deps.osVersion
        count["app_version"] = deps.appVersion
        count["model"] = deps.model
        guard let json = try? JSONSerialization.data(withJSONObject: count),
              let body = try? DeviceCore.count(json)
        else { return false }
        deps.send(body)
        return true
    }

    /// The counts of one card proof. Each step is sent once; after a stop,
    /// nothing more is: the card proof is over.
    @MainActor
    final class Attempt {
        private unowned let counts: Counts
        private let id: String
        private var reached: Set<String> = []
        private var stopped = false

        fileprivate init(counts: Counts, id: String) {
            self.counts = counts
            self.id = id
        }

        /// A card was read for this card proof, or it stopped: a card proof
        /// after it is another one. Taps that read no card are the same one's.
        var begun: Bool { stopped || reached.contains("certificates") }

        /// The card proof reached `step`.
        func step(_ step: String) {
            guard !stopped, reached.insert(step).inserted else { return }
            _ = counts.send(["event": "step", "step": step], attempt: id)
        }

        /// The card proof stopped, and is over.
        func stop(_ reason: String) {
            guard !stopped else { return }
            stopped = true
            send(reason: reason, as: "stop")
        }

        /// A step did not pass and can be tried again; the card proof goes on.
        func retry(_ reason: String) {
            guard !stopped else { return }
            send(reason: reason, as: "retry")
        }

        /// The card left the phone during tap `tap` (1, 2 or 3).
        func tapDropped(_ tap: Int) {
            guard !stopped else { return }
            _ = counts.send(["event": "action", "action": "tap_dropped", "tap": String(tap)], attempt: id)
        }

        /// The cardholder sent the same record again after a submission that did not get through.
        func resubmitted() {
            guard !stopped else { return }
            _ = counts.send(["event": "action", "action": "resubmit"], attempt: id)
        }

        /// The timed step `step` (`crl`, `tree`, `proved`) took `seconds`.
        func took(_ step: String, seconds: TimeInterval) {
            guard !stopped, let took = try? DeviceCore.countTook(milliseconds: UInt64(max(0, seconds) * 1000)) else { return }
            _ = counts.send(["event": "duration", "step": step, "took": took], attempt: id)
        }

        /// A code of the server's the table has no reason for is `server_other`.
        private func send(reason: String, as event: String) {
            if !counts.send(["event": event, "reason": reason], attempt: id), reason.hasPrefix("server_") {
                _ = counts.send(["event": event, "reason": "server_other"], attempt: id)
            }
        }
    }

    /// The reason code of `stop` (spec/counts.md, "Reasons"), chosen by its
    /// own codes and by nothing else it holds: not its dates, days, request
    /// ID, platform. Nil when there is none to count: a card that left
    /// during a tap, which is an action (`Attempt.tapDropped`).
    nonisolated static func reason(of stop: CardProofFlow.Stop) -> String? {
        switch stop {
        case .card(let failure):
            switch failure {
            case .noTap: return "no_tap"
            case .cancelled: return "tap_cancelled"
            case .pinIncorrect: return "pin_incorrect"
            case .locked: return "card_locked"
            case .channel: return "channel"
            case .firstGeneration: return "first_generation"
            case .otherCard: return "other_card"
            case .dropped(.sent): return "pin_maybe_received"
            case .dropped: return nil
            case .failed: return "card_error"
            }
        case .certificate(let problem, _):
            switch problem {
            case "no_certificate": return "no_certificate"
            case "expired": return "cert_expired"
            case "not_yet_valid": return "cert_not_yet_valid"
            case "not_citizen_primary": return "cert_not_citizen_primary"
            case "unsupported_format": return "cert_unsupported_format"
            case "unknown_issuer": return "cert_unknown_issuer"
            case "ambiguous_certificate": return "cert_ambiguous"
            default: return "engine"
            }
        // The core's reason codes, which are the table's (crl_unavailable, crl_stale, …), and `revoked`.
        case .revocation(let problem, _): return problem == "revoked" || problem.hasPrefix("crl_") ? problem : "engine"
        case .cardSignature: return "card_signature"
        case .server(let failure):
            return failure.code == "challenge_malformed" ? "challenge_malformed" : "server_\(failure.code)"
        case .artifact: return "artifact"
        case .core(let code): return code == IDC_ERR_ARGUMENT ? "clock" : "engine"
        case .username: return "username"
        case .blocked(let reason, _): return "blocked_\(reason)"
        case .challengeNotToday: return "challenge_not_today"
        case .dateChanged: return "date_changed"
        case .state: return "state"
        }
    }
}

extension Counts {
    /// The counts of this phone: sent to `backend`, the card proof device
    /// ID in the app's own user defaults, the system's version, the app's,
    /// the phone's model.
    static func ofThisDevice(backend: Backend) -> Counts {
        Counts(Dependencies(
            // Not waited for, in no order the server needs.
            send: { body in Task.detached { await backend.count(body) } },
            clock: Date.init,
            random: { count in
                var bytes = Data(count: count)
                let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
                // Without the random source, no ID: the core refuses what is not 16 bytes, and no count is sent.
                return status == errSecSuccess ? bytes : Data()
            },
            stored: { UserDefaults.standard.string(forKey: deviceIDKey) },
            // In place of the old one: the old one is kept nowhere.
            store: { UserDefaults.standard.set($0, forKey: deviceIDKey) },
            osVersion: UIDevice.current.systemVersion,
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            model: machine()))
    }

    /// Where the card proof device ID is kept in the app's user defaults.
    nonisolated static let deviceIDKey = "card-proof-device-id"

    /// The phone's model as the system names it (`iPhone15,2`): `utsname`'s
    /// machine, which on the simulator is the Mac's, so there the model it
    /// simulates. Never the name the phone's owner gave it (`UIDevice.name`).
    nonisolated static func machine() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}
