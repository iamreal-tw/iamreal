import XCTest
@testable import IamrealApp

/// The server's answer to a submission: how the app holds it
/// (CardProofFlow.Answer, read by the core, against
/// spec/vectors/records-response.json) and what the done screen says of it
/// (design/copy/card-proof.md, the section on the done screen). The
/// sentences expected here are looked up in design/copy/card-proof.json by
/// their keys.
final class DoneScreenTests: XCTestCase {
    typealias Flow = CardProofFlow

    private var copy: Copy!
    private var screens: Screens!

    override func setUpWithError() throws {
        copy = Copy(json: try Repository.data("design/copy/card-proof.json"))
        screens = Screens(copy: copy, host: "iamreal.tw")
    }

    // The answer, read by the core -----------------------------------------------------------

    func testTheAnswerIsWhatTheVectorsSayCaseByCase() throws {
        let cases = try XCTUnwrap(try Repository.vectors("records-response.json")["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 77)
        for item in cases {
            let name = try XCTUnwrap(item["name"] as? String)
            let body = Data(try XCTUnwrap(item["body"] as? String).utf8)
            let rows = try JSONSerialization.data(withJSONObject: try XCTUnwrap(item["rows"]))
            let result = try XCTUnwrap(item["result"] as? [String: Any])
            let kinds = (result["kinds"] as? [[String: Any]])?.map {
                Flow.Recorded(
                    platform: $0["platform"] as? String ?? "", kind: $0["kind"] as? String ?? "",
                    username: $0["username"] as? String ?? "", accountCards: $0["account_cards"] as? Int)
            }
            let expected = Flow.Answer(
                seq: result["seq"] as? Int, recordHash: result["record_hash"] as? String,
                kinds: kinds, mismatches: try XCTUnwrap(result["mismatches"] as? [String]))
            XCTAssertEqual(Flow.Answer.read(body, rows: rows), expected, name)
        }
    }

    func testRowsTheCoreDoesNotTakeAreAnAnswerWithNothingToldNotAFailure() throws {
        let body = Data(#"{"seq":138,"record_hash":"\#(String(repeating: "3f", count: 32))","kinds":[{"platform":"threads","kind":"first","username":"alice","account_cards":1}]}"#.utf8)
        XCTAssertNotEqual(Flow.Answer.read(body, rows: Data(#"[{"platform":"threads","kind":"first","username":"alice"}]"#.utf8)), .nothing)
        XCTAssertEqual(Flow.Answer.read(body, rows: Data("not rows".utf8)), .nothing)
    }

    // The done screen ----------------------------------------------------------------------------

    private func row(_ platform: String, _ kind: String, _ username: String, current: String? = nil, previous: String? = nil, known: Bool = true) -> Flow.ConsequenceRow {
        Flow.ConsequenceRow(platform: platform, known: known, kind: kind, username: username, current: current, previous: previous, switchesLeft: nil)
    }

    private func done(_ expected: [Flow.ConsequenceRow], _ kinds: [Flow.Recorded]?, mismatches: [String] = [], firstRecord: Bool = false, seq: Int? = 138) -> Flow.Done {
        Flow.Done(
            date: "2026-11-16", shortID: "7K2Q9FM4XD",
            accounts: expected.filter { $0.kind != "withdraw" }.map { Flow.Account(platform: $0.platform, username: $0.username) },
            expected: expected,
            answer: Flow.Answer(seq: seq, recordHash: seq == nil ? nil : String(repeating: "3f", count: 32), kinds: kinds, mismatches: mismatches),
            firstRecord: firstRecord)
    }

    private func recorded(_ platform: String, _ kind: String, _ username: String, _ cards: Int? = 1) -> Flow.Recorded {
        Flow.Recorded(platform: platform, kind: kind, username: username, accountCards: cards)
    }

    /// The blocks from "證明紀錄記下了這一筆" to the points, as their texts.
    private func record(of screen: Screen) throws -> [[String]] {
        let from = try XCTUnwrap(screen.blocks.firstIndex(of: .heading(copy("done.recorded"))))
        return screen.blocks[(from + 1)...].prefix { if case .points = $0 { return false } else { return true } }.map(\.texts)
    }

    private func title(of screen: Screen) -> String? {
        for case .title(let text) in screen.blocks { return text }
        return nil
    }

    func testAFirstDeclarationRecordedAsTheScreenSaid() throws {
        let screen = screens.done(done([row("threads", "first", "alice")], [recorded("threads", "first", "alice")], firstRecord: true), single: "Threads", copied: false)
        XCTAssertEqual(screen.blocks.first, .title(copy("done.first")))
        XCTAssertEqual(try record(of: screen), [
            ["2026-11-16"],
            [copy("done.record_single")],
            ["Threads", "@alice", copy("kinds.first")],
            [copy("done.short_id", ["short_id": "7K2Q9FM4XD"])],
        ])
        XCTAssertFalse(screen.texts.contains(copy("done.mismatch")))
    }

    func testTheTitlesByWhatTheServerRecorded() {
        let unchanged = [row("threads", "refresh", "alice", current: "alice")]
        XCTAssertEqual(title(of: screens.done(done(unchanged, [recorded("threads", "refresh", "alice")]), single: "Threads", copied: false)), copy("done.refresh"))
        // The server recorded a switch where the screen said nothing changes: not "unchanged".
        XCTAssertEqual(title(of: screens.done(done(unchanged, [recorded("threads", "switch", "alice")], mismatches: ["threads"]), single: "Threads", copied: false)), copy("done.changed"))
        XCTAssertEqual(title(of: screens.done(done([row("threads", "withdraw", "alice", current: "alice")], [recorded("threads", "withdraw", "alice", 0)]), single: "Threads", copied: false)), copy("done.withdraw_all"))
        XCTAssertEqual(title(of: screens.done(done(unchanged, nil), single: "Threads", copied: false)), copy("done.recorded_only"))
        // Nothing of the answer told, on a card's first record: still only that it was recorded.
        XCTAssertEqual(title(of: screens.done(done([row("threads", "first", "alice")], nil, firstRecord: true, seq: nil), single: "Threads", copied: false)), copy("done.recorded_only"))
    }

    func testKindsTheAppCannotReadOnlyThatTheListWasRecorded() throws {
        let screen = screens.done(done([row("threads", "first", "alice")], nil), single: "Threads", copied: false)
        XCTAssertEqual(try record(of: screen), [["2026-11-16"], [copy("done.kinds_unreadable")]])
        // The proof and the link are shown all the same: the list that was sent.
        XCTAssertTrue(screen.blocks.contains(.link("iamreal.tw/p/7K2Q9FM4XD")))
        XCTAssertTrue(screen.blocks.contains(.row(name: "Threads", account: "@alice", lines: [])))
    }

    func testOtherCardsDeclareTheAccountTooSaidOncePerSuchAccountAndNotOfOneWithdrawn() throws {
        let expected = [row("test-example", "withdraw", "a-b", current: "a-b", known: false), row("threads", "refresh", "alice", current: "alice")]
        let screen = screens.done(done(expected, [recorded("test-example", "withdraw", "a-b", 4), recorded("threads", "refresh", "alice", 2)]), single: nil, copied: false)
        XCTAssertEqual(try record(of: screen), [
            ["2026-11-16"],
            [copy("done.record_list")],
            ["test-example", "a-b", copy("kinds.withdraw")],
            ["Threads", "@alice", copy("kinds.unchanged")],
            [copy("done.short_id", ["short_id": "7K2Q9FM4XD"])],
            [copy("done.other_cards", ["account": "@alice"])],
        ])
        XCTAssertTrue(screen.texts.contains(copy("done.withdrawn_link")))
        // One card, or a number the answer does not have: nothing said.
        for cards in [1, 0, nil] {
            let alone = screens.done(done([expected[1]], [recorded("threads", "refresh", "alice", cards)]), single: "Threads", copied: false)
            XCTAssertFalse(alone.texts.contains(copy("done.other_cards", ["account": "@alice"])))
        }
    }

    func testASwitchRecordedWhereTheScreenSaidACorrection() throws {
        let shown = row("threads", "correction", "bob", current: "alice", previous: "alice")
        let screen = screens.done(done([shown], [recorded("threads", "switch", "bob")], mismatches: ["threads"]), single: "Threads", copied: false)
        // First of all, above the title.
        XCTAssertEqual(Array(screen.blocks.prefix(2)), [.message(copy("done.mismatch")), .title(copy("done.changed"))])
        XCTAssertEqual(try record(of: screen)[2], [
            "Threads", "@bob", copy("kinds.switch", ["previous": "@alice"]),
            copy("done.mismatch_expected", ["expected": copy("kinds.switch", ["previous": "@alice"]) + copy("confirm.switch_not_counted")]),
            copy("done.mismatch_switch_used"),
        ])
    }

    func testAnotherAccountAPlatformMoreAndAPlatformLess() throws {
        let expected = [row("test-example", "refresh", "a-b", current: "a-b", known: false), row("threads", "refresh", "alice", current: "alice")]
        let kinds = [recorded("threads", "refresh", "carol"), recorded("x-new", "switch", "zed")]
        let screen = screens.done(done(expected, kinds, mismatches: ["test-example", "threads", "x-new"]), single: nil, copied: false)
        XCTAssertEqual(screen.blocks.first, .message(copy("done.mismatch")))
        let unchanged = copy("done.mismatch_expected", ["expected": copy("kinds.unchanged")])
        XCTAssertEqual(Array(try record(of: screen)[2...4]), [
            // Step 5 showed it, the answer has nothing: no sentence of what was recorded.
            ["test-example", "a-b", unchanged],
            ["Threads", "@carol", copy("kinds.again"), unchanged],
            // The answer has a platform step 5 did not show: a switch from an account the app does not have.
            ["x-new", "zed", copy("done.mismatch_expected", ["expected": copy("done.mismatch_no_platform")]), copy("done.mismatch_switch_used")],
        ])
    }
}
