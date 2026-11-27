import UIKit
import XCTest
@testable import IamrealApp

/// The counts of the app's card proofs (spec/counts.md; ADR-0039), without
/// a back end: the card proof device ID by the core's rule, what a count
/// carries and does not, the reason of every stop, and the submission
/// carrying the device ID. The bodies are the core's (`idc_count`), so each
/// one here is one the server takes. CardProofTests looks at the counts of
/// whole card proofs against the Worker.
@MainActor
final class CountsTests: XCTestCase {
    private var sent: [[String: String]] = []
    private var stored: String?
    private var now = Date(timeIntervalSince1970: 1_800_000_000)
    private var next: UInt8 = 0

    private func counts(osVersion: String = "18.1.1", appVersion: String = "2026.11.5", model: String = "iPhone15,2") -> Counts {
        Counts(Counts.Dependencies(
            send: { [unowned self] body in
                if let count = (try? JSONSerialization.jsonObject(with: body)) as? [String: String] { self.sent.append(count) }
            },
            clock: { [unowned self] in self.now },
            // Not random: each ID is told apart from the one before.
            random: { [unowned self] count in
                self.next += 1
                return Data(repeating: self.next, count: count)
            },
            stored: { [unowned self] in self.stored },
            store: { [unowned self] in self.stored = $0 },
            osVersion: osVersion,
            appVersion: appVersion,
            model: model))
    }

    private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    /// spec/vectors/counts.json, `device_ids`: the ID used and the value kept, by the core's rule.
    func testTheDeviceIDOfEveryCaseOfTheVectors() throws {
        let vectors = try XCTUnwrap(try JSONSerialization.jsonObject(with: Repository.data("spec/vectors/counts.json")) as? [String: Any])
        let cases = try XCTUnwrap(vectors["device_ids"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = try XCTUnwrap(c["name"] as? String)
            let hex = try XCTUnwrap(c["random"] as? String)
            let random = Data(stride(from: 0, to: hex.count, by: 2).map { UInt8(hex.dropFirst($0).prefix(2), radix: 16)! })
            stored = c["stored"] as? String
            let kept = stored
            now = Date(timeIntervalSince1970: try XCTUnwrap(c["now"] as? Double))
            let counts = Counts(Counts.Dependencies(
                send: { _ in }, clock: { [unowned self] in self.now }, random: { _ in random },
                stored: { [unowned self] in self.stored }, store: { [unowned self] in self.stored = $0 },
                osVersion: "", appVersion: "", model: ""))
            XCTAssertEqual(counts.deviceID(), c["device_id"] as? String, name)
            XCTAssertEqual(stored, (c["store"] as? String) ?? kept, name)
        }
    }

    /// spec/vectors/counts.json, `durations_of`: the duration of each time, none below 0.
    func testEveryDurationOfTheVectors() throws {
        let vectors = try XCTUnwrap(try JSONSerialization.jsonObject(with: Repository.data("spec/vectors/counts.json")) as? [String: Any])
        let cases = try XCTUnwrap(vectors["durations_of"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let ms = try XCTUnwrap(c["ms"] as? Double)
            sent = []
            counts().attempt().took("tree", seconds: ms / 1000)
            XCTAssertEqual(sent.first?["took"], c["took"] as? String, "\(ms) ms")
        }
    }

    /// A count that cannot be sent is nobody's: the back end's request returns, throwing nothing, when no server answers.
    func testACountThatCannotBeSentHoldsNothingUp() async {
        let backend = HTTPBackend(site: URL(string: "http://127.0.0.1:1")!, publicFiles: URL(string: "http://127.0.0.1:1")!)
        await backend.count(Data("{}".utf8))
    }

    func testACountCarriesTheClientTheTwoIDsTheVersionsAndTheModelAndNothingElse() throws {
        let counts = counts()
        let attempt = counts.attempt()
        attempt.step("read")
        let count = try XCTUnwrap(sent.last)
        XCTAssertEqual(Set(count.keys), ["client", "event", "step", "device_id", "attempt_id", "os_version", "app_version", "model"])
        XCTAssertEqual(count["client"], "ios")
        XCTAssertEqual(count["device_id"], counts.deviceID())
        XCTAssertNotEqual(count["device_id"], count["attempt_id"])
        XCTAssertEqual(count["os_version"], "18.1.1")
        XCTAssertEqual(count["app_version"], "2026.11.5")
        XCTAssertEqual(count["model"], "iPhone15,2")
        // A version or a model not in its format is left out, not rewritten.
        let odd = self.counts(osVersion: "18.1 beta", appVersion: "dev", model: "Alice’s iPhone")
        odd.attempt().step("open")
        let left = try XCTUnwrap(sent.last)
        for member in ["os_version", "app_version", "model"] { XCTAssertNil(left[member], member) }
    }

    func testEachStepOnceNothingAfterAStopAndAnUnknownCodeOfTheServerIsServerOther() {
        let attempt = counts().attempt()
        attempt.step("read")
        attempt.step("read")
        attempt.retry("no_tap")
        attempt.tapDropped(2)
        attempt.took("tree", seconds: 12.345)
        attempt.took("crl", seconds: -1)
        attempt.resubmitted()
        attempt.retry("server_http_502")
        attempt.stop("server_teapot")
        attempt.step("certificates")
        attempt.stop("engine")
        let said = sent.map { c -> String in
            switch c["event"] {
            case "step": return "step:\(c["step"]!)"
            case "action": return "action:\(c["action"]!)" + (c["tap"].map { ":\($0)" } ?? "")
            case "duration": return "duration:\(c["step"]!):\(c["took"]!)"
            default: return "\(c["event"]!):\(c["reason"]!)"
            }
        }
        XCTAssertEqual(said, ["step:read", "retry:no_tap", "action:tap_dropped:2", "duration:tree:10s_30s", "action:resubmit", "retry:server_other", "stop:server_other"])
    }

    /// Every stop the flow makes has a reason the server takes from the iOS app, or none.
    func testEveryStopHasAReasonOfTheTable() throws {
        let failures: [CardFailure] = [.noTap, .cancelled, .pinIncorrect, .locked, .channel, .firstGeneration, .otherCard, .dropped(.notSent), .dropped(.sent), .dropped(.accepted), .failed(code: "x")]
        var stops: [CardProofFlow.Stop] = failures.map { .card($0) }
        stops += ["no_certificate", "expired", "not_yet_valid", "not_citizen_primary", "unsupported_format", "unknown_issuer", "ambiguous_certificate"].map { .certificate(problem: $0, date: "270101000000") }
        stops += ["crl_unavailable", "crl_hash", "crl_unusable", "crl_rollback", "crl_stale", "revoked"].map { .revocation(problem: $0, days: 9) }
        stops += ["network", "malformed_response", "paused", "busy", "rate_limited", "internal", "crl_stale", "challenge_unknown", "challenge_used", "challenge_attempts", "proof", "root", "date_order", "empty", "switch_limit", "daily_limit", "malformed", "scope", "platform", "challenge_malformed"].map { .server(BackendFailure(code: $0, requestID: "0123456789abcdef")) }
        stops += [.cardSignature, .artifact, .core(IDC_ERR_INTERNAL), .core(IDC_ERR_ARGUMENT), .username(platform: "threads"), .blocked(reason: "empty", platform: nil), .blocked(reason: "switch_limit", platform: "threads"), .blocked(reason: "daily_limit", platform: nil), .challengeNotToday, .state]
        for stop in stops {
            guard let reason = Counts.reason(of: stop) else {
                // A card that left during a tap: an action.
                if case .card(.dropped(let fate)) = stop { XCTAssertNotEqual(fate, .sent); continue }
                XCTFail("no reason for \(stop)")
                continue
            }
            let body = #"{"client":"ios","event":"stop","reason":"\#(reason)","device_id":"\#(String(repeating: "1", count: 32))","attempt_id":"\#(String(repeating: "2", count: 32))"}"#
            XCTAssertNoThrow(try DeviceCore.count(Data(body.utf8)), "\(stop): \(reason)")
        }
        XCTAssertEqual(Counts.reason(of: .card(.dropped(.sent))), "pin_maybe_received")
        XCTAssertEqual(Counts.reason(of: .core(IDC_ERR_ARGUMENT)), "clock")
        XCTAssertEqual(Counts.reason(of: .server(BackendFailure(code: "challenge_malformed", requestID: nil))), "challenge_malformed")
    }

    func testTheSubmissionCarriesTheDeviceID() {
        let id = "0123456789abcdef0123456789abcdef"
        XCTAssertEqual(String(decoding: CardProofFlow.withDeviceID(Data(#"{"scoped_id":"x"}"#.utf8), id), as: UTF8.self), #"{"device_id":"0123456789abcdef0123456789abcdef","scoped_id":"x"}"#)
        // Not a body, or not an ID: as it is.
        XCTAssertEqual(CardProofFlow.withDeviceID(Data("{}".utf8), id), Data("{}".utf8))
        XCTAssertEqual(CardProofFlow.withDeviceID(Data(#"{"a":1}"#.utf8), "x"), Data(#"{"a":1}"#.utf8))
    }

    func testTheModelIsTheSystemsIdentifier() {
        let model = Counts.machine()
        XCTAssertNotNil(model.range(of: #"^[A-Za-z0-9 \-_.,()+]{1,32}$"#, options: .regularExpression), model)
        XCTAssertNotEqual(model, UIDevice.current.name)
    }
}
