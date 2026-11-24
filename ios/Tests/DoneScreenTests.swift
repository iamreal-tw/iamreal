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

    /// The blocks from "證明紀錄記下了這一筆" to what can also be done, as their texts.
    private func record(of screen: Screen) throws -> [[String]] {
        let from = try XCTUnwrap(screen.blocks.firstIndex(of: .heading(copy("done.recorded"))))
        return screen.blocks[(from + 1)...].prefix { if case .kicker = $0 { return false } else { return true } }.map(\.texts)
    }

    private func title(of screen: Screen) -> String? {
        for case .doneHead(_, let title, _) in screen.blocks { return title }
        return nil
    }

    /// The screen of a first declaration, word for word as
    /// design/copy/card-proof.md writes step 6 and its "app".
    func testAFirstDeclarationRecordedAsTheScreenSaid() throws {
        let screen = screens.done(done([row("threads", "first", "alice")], [recorded("threads", "first", "alice")], firstRecord: true), single: "Threads", copied: false)
        XCTAssertEqual(screen.texts, [
            "島民證明", "@alice", "島民編號 7K2Q9FM4XD 開頭",
            "你拿到島民證明了",
            "2026-11-16 記進了證明紀錄。",
            "最後一步：掛到你的 Threads 個人檔案",
            "任何人都能宣告任何帳號。你把連結掛上個人檔案，別人才知道這個帳號承認這張證明。",
            "iamreal.tw/p/7K2Q9FM4XD",
            "複製連結",
            "打開 @alice 的 Threads 個人檔案",
            "按「編輯個人檔案」", "按「連結」，貼上剛才複製的連結", "存檔",
            "如果你換了新的自然人憑證：新卡片的島民編號和連結都和舊的不同。請把個人檔案的連結換成這一個。",
            "掛好了嗎？打開你的島民證明看看。",
            "頁面上的個人檔案裡看得到這個連結，就成功了。",
            "還可以做的，不做也不影響這張證明",
            "讓朋友也知道", "把你的島民證明分享到 Threads。", "分享",
            "記得每三個月回來過卡一次", "越久沒過卡，說服力越低。每次過卡，島民證明上的日期就會更新成今天。",
            "回到開頭",
        ])
        // One main button: copying the link. The way back to the start is not it.
        XCTAssertFalse(screen.mainButton)
        let inline = screen.blocks.compactMap { block -> (Action, Bool)? in
            switch block {
            case .button(let button, let main): return (button.action, main)
            case .linked(_, let link, _): return (link.action, false)
            default: return nil
            }
        }
        XCTAssertEqual(inline.map(\.0), [.copyLink, .openProfile("threads"), .openProof, .share])
        XCTAssertEqual(inline.map(\.1), [true, false, false, false])
        // As step 5 said: the record is not shown again.
        XCTAssertNil(screen.blocks.firstIndex(of: .heading(copy("done.recorded"))))
    }

    func testEveryAccountWithdrawnNoCardNoHangingNothingMoreToDo() {
        let screen = screens.done(done([row("threads", "withdraw", "alice", current: "alice")], [recorded("threads", "withdraw", "alice", 0)]), single: "Threads", copied: false)
        XCTAssertEqual(screen.texts, [
            "已全部收回",
            "2026-11-16 記進了證明紀錄。",
            "已經收回的帳號，個人檔案上的連結可以拿掉。",
            "回到開頭",
        ])
    }

    func testTheCopiedLinkSaysSo() {
        let screen = screens.done(done([row("threads", "refresh", "alice", current: "alice")], [recorded("threads", "refresh", "alice")]), single: "Threads", copied: true)
        XCTAssertTrue(screen.texts.contains("已複製"))
        XCTAssertFalse(screen.texts.contains("複製連結"))
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
        let card = ProofCard(label: copy("done.proof"), rows: [ProofCard.Row(name: nil, account: "@alice")], shortID: "島民編號 7K2Q9FM4XD 開頭")
        XCTAssertEqual(screen.blocks.first, .doneHead(card, title: copy("done.recorded_only"), lines: [copy("done.recorded_on", ["date": "2026-11-16"]), copy("done.kinds_unreadable")]))
        // The link is shown all the same: the list that was sent is on the card.
        XCTAssertTrue(screen.blocks.contains(.link("iamreal.tw/p/7K2Q9FM4XD")))
    }

    func testOtherCardsDeclareTheAccountTooSaidOncePerSuchAccountAndNotOfOneWithdrawn() throws {
        let expected = [row("test-example", "withdraw", "a-b", current: "a-b", known: false), row("threads", "refresh", "alice", current: "alice")]
        let screen = screens.done(done(expected, [recorded("test-example", "withdraw", "a-b", 4), recorded("threads", "refresh", "alice", 2)]), single: nil, copied: false)
        let notes = screen.blocks.compactMap { block -> String? in if case .small(let text) = block { return text } else { return nil } }
        XCTAssertEqual(notes, [copy("done.withdrawn_link"), copy("done.other_cards", ["account": "@alice"])])
        // More than one platform: the card names each account's platform, and the title is the general one.
        guard case .doneHead(let card?, _, _) = screen.blocks.first else { return XCTFail("no small card") }
        XCTAssertEqual(card.rows, [ProofCard.Row(name: "Threads", account: "@alice")])
        XCTAssertTrue(screen.texts.contains(copy("done.hang_title")))
        XCTAssertTrue(screen.texts.contains(copy("done.anyone")))
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
        XCTAssertEqual(screen.blocks.first, .message(copy("done.mismatch")))
        XCTAssertEqual(title(of: screen), copy("done.changed"))
        XCTAssertEqual(try record(of: screen), [
            ["2026-11-16"],
            [copy("done.record_single")],
            [
                "Threads", "@bob", copy("kinds.switch", ["previous": "@alice"]),
                copy("done.mismatch_expected", ["expected": copy("kinds.switch", ["previous": "@alice"]) + copy("confirm.switch_not_counted")]),
                copy("done.mismatch_switch_used"),
            ],
            [copy("done.short_id", ["short_id": "7K2Q9FM4XD"])],
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
