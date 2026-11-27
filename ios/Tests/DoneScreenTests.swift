import XCTest
@testable import IamrealApp

/// The server's answer to a submission: how the app holds it
/// (CardProofFlow.Answer, read by the core, against
/// spec/vectors/records-response.json) and what the steps after it say
/// (design/copy/card-proof.md, steps 6 to 8: hanging the link, the
/// reminder, done and sharing). The
/// sentences expected here are looked up in design/copy/card-proof.json by
/// their keys.
final class DoneScreenTests: XCTestCase {
    typealias Flow = CardProofFlow

    private var copy: Copy!
    private var screens: Screens!

    override func setUpWithError() throws {
        copy = Copy(json: try Repository.data("design/copy/card-proof.json"))
        screens = Screens(copy: copy, appCopy: Copy(json: try Repository.data("design/copy/app.json")), host: "iamreal.tw")
    }

    // The answer, read by the core -----------------------------------------------------------

    func testTheAnswerIsWhatTheVectorsSayCaseByCase() throws {
        let cases = try XCTUnwrap(try Repository.vectors("records-response.json")["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 91)
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
                seq: result["seq"] as? Int, recordHash: result["record_hash"] as? String, ordinal: result["ordinal"] as? Int,
                kinds: kinds, mismatches: try XCTUnwrap(result["mismatches"] as? [String]))
            XCTAssertEqual(Flow.Answer.read(body, rows: rows), expected, name)
        }
    }

    func testRowsTheCoreDoesNotTakeAreAnAnswerWithNothingToldNotAFailure() throws {
        let body = Data(#"{"seq":138,"record_hash":"\#(String(repeating: "3f", count: 32))","kinds":[{"platform":"threads","kind":"first","username":"alice","account_cards":1}]}"#.utf8)
        XCTAssertNotEqual(Flow.Answer.read(body, rows: Data(#"[{"platform":"threads","kind":"first","username":"alice"}]"#.utf8)), .nothing)
        XCTAssertEqual(Flow.Answer.read(body, rows: Data("not rows".utf8)), .nothing)
    }

    // The steps after the record was sent ------------------------------------------------------

    private func row(_ platform: String, _ kind: String, _ username: String, current: String? = nil, previous: String? = nil, known: Bool = true) -> Flow.ConsequenceRow {
        Flow.ConsequenceRow(platform: platform, known: known, kind: kind, username: username, current: current, previous: previous, switchesLeft: nil)
    }

    private func done(_ expected: [Flow.ConsequenceRow], _ kinds: [Flow.Recorded]?, mismatches: [String] = [], firstRecord: Bool = false, seq: Int? = 138, ordinal: Int? = 128) -> Flow.Done {
        Flow.Done(
            date: "2026-11-16", shortID: "7K2Q9FM4XD",
            accounts: expected.filter { $0.kind != "withdraw" }.map { Flow.Account(platform: $0.platform, username: $0.username) },
            expected: expected,
            answer: Flow.Answer(seq: seq, recordHash: seq == nil ? nil : String(repeating: "3f", count: 32), ordinal: seq == nil ? nil : ordinal, kinds: kinds, mismatches: mismatches),
            firstRecord: firstRecord)
    }

    private func recorded(_ platform: String, _ kind: String, _ username: String, _ cards: Int? = 1) -> Flow.Recorded {
        Flow.Recorded(platform: platform, kind: kind, username: username, accountCards: cards)
    }

    /// The blocks after "證明紀錄記下了這一筆", as their texts.
    private func record(of screen: Screen) throws -> [[String]] {
        let from = try XCTUnwrap(screen.blocks.firstIndex(of: .heading(copy("done.recorded"))))
        return screen.blocks[(from + 1)...].map(\.texts)
    }

    private func title(of screen: Screen) -> String? {
        for case .title(let title) in screen.blocks { return title }
        return nil
    }

    /// The buttons and links among the blocks, with whether each is the main button.
    private func inline(_ screen: Screen) -> [(action: Action, main: Bool)] {
        screen.blocks.compactMap { block in
            switch block {
            case .button(let button, let main): return (button.action, main)
            case .linked(_, let link, _): return (link.action, false)
            case .action(let link): return (link.action, false)
            default: return nil
            }
        }
    }

    private let first = "first"
    private var again: Flow.Done { done([row("threads", "refresh", "alice", current: "alice")], [recorded("threads", "refresh", "alice")]) }

    // Step 6: hanging the link -----------------------------------------------------------------

    /// The whole of step 6 for a card's first record, word for word as
    /// design/copy/card-proof.md writes it for the app.
    func testStepSixOfAFirstDeclaration() throws {
        let screen = screens.hang(done([row("threads", "first", "alice")], [recorded("threads", "first", "alice")], firstRecord: true), single: "Threads", copied: false)
        XCTAssertEqual(screen.step, 6)
        XCTAssertEqual(screen.texts, [
            "2026-11-16 記進了證明紀錄。",
            "把證明掛上你的 Threads 個人檔案",
            "在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。",
            "iamreal.tw/p/7K2Q9FM4XD",
            "複製證明連結",
            "打開 Threads",
            // The demonstration: what VoiceOver reads in its place, and its one button.
            "示範：按「複製證明連結」，到 Threads 的個人檔案按「編輯個人檔案」、「連結」、「新增連結」，貼上網址後按「完成」，個人檔案上多了一行連結。",
            "再看一次",
            "按「編輯個人檔案」", "按「連結」", "按「新增連結」", "在「網址」貼上剛才複製的連結，按右上角的「完成」",
            "如果你換了新的自然人憑證，請把個人檔案的連結換成新的連結。",
            "掛好了嗎？打開你的島民證明看看。",
            "頁面上的個人檔案裡看得到這個連結，就成功了。",
            "下一步",
        ])
        // The two buttons side by side, above the demonstration, as on its first screen; the first is the
        // screen's one main button. The way on is not it, and there is no way back: the record was sent.
        let pair = try XCTUnwrap(screen.blocks.firstIndex(of: .sideBySide([
            Button(label: "複製證明連結", action: .copyLink),
            Button(label: "打開 Threads", action: .openProfile("threads"), spoken: "打開 @alice 的 Threads 個人檔案"),
        ])))
        guard case .demo = screen.blocks[pair + 1], case .steps = screen.blocks[pair + 2] else { return XCTFail("the buttons, the demonstration, the four steps: \(screen.blocks)") }
        XCTAssertEqual(inline(screen).map(\.action), [.openProof])
        XCTAssertFalse(screen.mainButton)
        XCTAssertEqual(screen.buttons, [Button(label: "下一步", action: .toRemind)])
        XCTAssertNil(screen.settings)
        // As step 5 said: the record is not shown again.
        XCTAssertNil(screen.blocks.firstIndex(of: .heading(copy("done.recorded"))))
        try CopyDocument.load().check(screen)
    }

    /// A card proof again: only whether the link is still there; the whole step is one button away.
    func testStepSixOfACardProofAgainIsTheShortOne() throws {
        let screen = screens.hang(again, single: "Threads", copied: false)
        XCTAssertEqual(screen.texts, [
            "2026-11-16 記進了證明紀錄。",
            "你的 Threads 個人檔案上，還有這個連結嗎？",
            "iamreal.tw/p/7K2Q9FM4XD",
            "打開你的島民證明看看。",
            "在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。",
            "重新掛上連結",
            "下一步",
        ])
        XCTAssertEqual(screen.buttons.map(\.action), [.rehang, .toRemind])
        XCTAssertTrue(screen.mainButton, "the way on is the main button")
        XCTAssertEqual(inline(screen).map(\.action), [.openProof])
        try CopyDocument.load().check(screen)
        // "重新掛上連結": the whole step, without the sentence of a new card.
        XCTAssertFalse(screen.blocks.contains { if case .demo = $0 { return true } else { return false } }, "no demonstration on the short step")
        let whole = screens.hang(again, single: "Threads", copied: false, whole: true)
        XCTAssertEqual(whole.step, 6)
        XCTAssertEqual(title(of: whole), "把證明掛上你的 Threads 個人檔案")
        XCTAssertTrue(whole.texts.contains("複製證明連結"))
        XCTAssertFalse(whole.texts.contains(copy("hang.new_card")))
        // Reached from the short one: 上一步 back to it, left of 下一步 (card-proof.md, step 6, the short one).
        XCTAssertEqual(whole.buttons, [Button(label: "上一步", action: .back), Button(label: "下一步", action: .toRemind)])
        XCTAssertFalse(whole.mainButton)
        try CopyDocument.load().check(whole)
    }

    /// The short step only for a card proof again with one platform, recorded as step 5 said.
    func testStepSixIsTheWholeOneOtherwise() {
        let unchanged = [row("threads", "refresh", "alice", current: "alice")]
        XCTAssertTrue(screens.hangIsShort(again, single: "Threads"))
        // More than one platform.
        XCTAssertFalse(screens.hangIsShort(again, single: nil))
        // A switch, a declaration again after a withdrawal, a first record.
        XCTAssertFalse(screens.hangIsShort(done([row("threads", "switch", "bob", current: "alice", previous: "alice")], [recorded("threads", "switch", "bob")]), single: "Threads"))
        XCTAssertFalse(screens.hangIsShort(done([row("threads", "refresh", "alice")], [recorded("threads", "refresh", "alice")]), single: "Threads"))
        XCTAssertFalse(screens.hangIsShort(done([row("threads", "first", "alice")], [recorded("threads", "first", "alice")], firstRecord: true), single: "Threads"))
        // Recorded as something else than step 5 said, or not read.
        XCTAssertFalse(screens.hangIsShort(done(unchanged, [recorded("threads", "switch", "alice")], mismatches: ["threads"]), single: "Threads"))
        XCTAssertFalse(screens.hangIsShort(done(unchanged, nil), single: "Threads"))
    }

    // The demonstration of step 6 -----------------------------------------------------------------

    private func demo(of screen: Screen) -> HangDemo? {
        for case .demo(let demo) in screen.blocks { return demo }
        return nil
    }

    /// Its one button says what it does: it plays it again while it does not play, and stops it while it does.
    func testTheDemonstrationsButtonSaysWhatItDoes() throws {
        let still = try XCTUnwrap(demo(of: screens.hang(again, single: "Threads", copied: false, whole: true)))
        XCTAssertEqual(still.control, Button(label: "再看一次", action: .playDemo))
        XCTAssertFalse(still.playing)
        XCTAssertFalse(still.played, "its first frame, before it ever played")
        let playing = try XCTUnwrap(demo(of: screens.hang(again, single: "Threads", copied: false, whole: true, demoPlaying: true)))
        XCTAssertEqual(playing.control, Button(label: "停止播放", action: .stopDemo))
        XCTAssertTrue(playing.playing)
        XCTAssertTrue(playing.played)
        // Stopped or at its end: its last frame.
        XCTAssertTrue(try XCTUnwrap(demo(of: screens.hang(again, single: "Threads", copied: false, whole: true, demoPlayed: true))).played)
        try CopyDocument.load().check(screens.hang(again, single: "Threads", copied: false, whole: true, demoPlaying: true))
    }

    /// The account and the address on the five screens are the card's own; every other word on them is
    /// one of card-proof.md's list for the demonstration, and the first screen is this step's own.
    func testTheDemonstrationShowsTheCardsOwnAccountAndAddress() throws {
        let finished = done([row("threads", "switch", "carol.tw", current: "alice", previous: "alice")], [recorded("threads", "switch", "carol.tw")])
        let demo = try XCTUnwrap(demo(of: screens.hang(finished, single: "Threads", copied: false)))
        XCTAssertEqual(demo.account, "@carol.tw")
        XCTAssertEqual(demo.link, "iamreal.tw/p/7K2Q9FM4XD")
        XCTAssertEqual(demo.address, "https://iamreal.tw/p/7K2Q9FM4XD")
        XCTAssertEqual(demo.words.all, [
            "把證明掛上你的 Threads 個人檔案", "複製證明連結", "已複製", "打開 Threads",
            "編輯個人檔案", "訪客找的就是這一行",
            "名稱", "用戶名稱", "個人簡介", "興趣", "連結", "精選",
            "新增連結", "完成", "網址", "貼上", "標題（選填）",
        ])
        let document = try CopyDocument.load()
        for sentence in demo.words.all { XCTAssertTrue(document.contains(sentence), "not in design/copy/card-proof.md: \(sentence)") }
        // More than one platform: still the account on Threads. A card without one has no demonstration.
        let two = [row("test-example", "refresh", "a-b", current: "a-b", known: false), row("threads", "refresh", "alice", current: "alice")]
        XCTAssertEqual(self.demo(of: screens.hang(done(two, [recorded("test-example", "refresh", "a-b"), recorded("threads", "refresh", "alice")]), single: nil, copied: false))?.account, "@alice")
        let none = [row("test-example", "refresh", "a-b", current: "a-b", known: false)]
        XCTAssertNil(self.demo(of: screens.hang(done(none, [recorded("test-example", "refresh", "a-b")]), single: nil, copied: false)))
    }

    func testTheCopiedLinkSaysSo() {
        let screen = screens.hang(again, single: "Threads", copied: true, whole: true)
        XCTAssertTrue(screen.texts.contains("已複製"))
        XCTAssertFalse(screen.texts.contains("複製證明連結"))
    }

    func testKindsTheAppCannotReadTheWholeStepAndThatTheListWasRecorded() throws {
        let screen = screens.hang(done([row("threads", "refresh", "alice", current: "alice")], nil), single: "Threads", copied: false)
        XCTAssertEqual(Array(screen.blocks.prefix(3)), [
            .text(copy("done.recorded_on", ["date": "2026-11-16"])),
            .text(copy("done.kinds_unreadable")),
            .title(copy("hang.title_single", ["platform": "Threads"])),
        ])
        // The link is shown all the same.
        XCTAssertTrue(screen.blocks.contains(.link("iamreal.tw/p/7K2Q9FM4XD")))
        try CopyDocument.load().check(screen)
    }

    func testOtherCardsDeclareTheAccountTooSaidOncePerSuchAccountAndNotOfOneWithdrawn() throws {
        let expected = [row("test-example", "withdraw", "a-b", current: "a-b", known: false), row("threads", "refresh", "alice", current: "alice")]
        let screen = screens.hang(done(expected, [recorded("test-example", "withdraw", "a-b", 4), recorded("threads", "refresh", "alice", 2)]), single: nil, copied: false)
        let notes = screen.blocks.compactMap { block -> String? in if case .small(let text) = block { return text } else { return nil } }
        XCTAssertEqual(notes, [copy("done.withdrawn_link"), copy("done.other_cards", ["account": "@alice"])])
        // More than one platform: the title and the reason are the general ones.
        XCTAssertEqual(title(of: screen), copy("hang.title"))
        XCTAssertTrue(screen.texts.contains(copy("done.anyone")))
        try CopyDocument.load().check(screen)
        // One card, or a number the answer does not have: nothing said.
        for cards in [1, 0, nil] {
            let alone = screens.hang(done([expected[1]], [recorded("threads", "refresh", "alice", cards)]), single: "Threads", copied: false, whole: true)
            XCTAssertFalse(alone.texts.contains(copy("done.other_cards", ["account": "@alice"])))
        }
    }

    func testASwitchRecordedWhereTheScreenSaidTheAccountStays() throws {
        // A card's state that hid the switch: the screen took bob for the account declared now.
        let shown = row("threads", "refresh", "bob", current: "bob")
        let screen = screens.hang(done([shown], [recorded("threads", "switch", "bob")], mismatches: ["threads"]), single: "Threads", copied: false)
        // First of all, above the date.
        XCTAssertEqual(Array(screen.blocks.prefix(2)), [.message(copy("done.mismatch")), .text(copy("done.recorded_on", ["date": "2026-11-16"]))])
        XCTAssertEqual(try record(of: screen), [
            ["2026-11-16"],
            [copy("done.record_single")],
            [
                "Threads", "@bob", copy("kinds.switch", ["previous": "@bob"]),
                copy("done.mismatch_expected", ["expected": copy("kinds.unchanged")]),
                copy("done.mismatch_switch_used"),
            ],
            [copy("done.short_id", ["short_id": "7K2Q9FM4XD"])],
        ])
    }

    func testAnotherAccountAPlatformMoreAndAPlatformLess() throws {
        let expected = [row("test-example", "refresh", "a-b", current: "a-b", known: false), row("threads", "refresh", "alice", current: "alice")]
        let kinds = [recorded("threads", "refresh", "carol"), recorded("x-new", "switch", "zed")]
        let screen = screens.hang(done(expected, kinds, mismatches: ["test-example", "threads", "x-new"]), single: nil, copied: false)
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

    // Step 7: the reminder -------------------------------------------------------------------------

    private let threeMonths = ReminderSettings(interval: .weeks12, time: .evening, next: Day(2027, 2, 8))

    /// Nothing kept: the question, the day the default would set, and three ways on.
    func testStepSevenAsksWithTheDayTheDefaultWouldSet() throws {
        let screen = screens.remind(.ask(threeMonths), notAfter: nil)
        XCTAssertEqual(screen.step, 7)
        XCTAssertEqual(screen.texts, [
            "提醒我回來過卡",
            "建議定期更新島民證明，增加說服力。",
            "這支手機會在 2027-02-08（星期一）晚上 9:00 提醒你，大約三個月後。",
            "上一步", "開啟提醒",
            "改提醒間隔或時刻",
            "這次不要",
        ])
        XCTAssertEqual(screen.buttons.map(\.action), [.back, .turnOnReminder])
        XCTAssertEqual(screen.links.map(\.action), [.adjustReminder, .toFinish])
        XCTAssertTrue(screen.mainButton)
        try CopyDocument.load().check(screen)
    }

    /// On already: when it was set again, the way on, and no way to say no here.
    func testStepSevenWithTheReminderOn() throws {
        let screen = screens.remind(.on(threeMonths, counted: true), notAfter: nil)
        XCTAssertEqual(screen.texts, [
            "提醒我回來過卡",
            "建議定期更新島民證明，增加說服力。",
            "這支手機會在 2027-02-08（星期一）晚上 9:00 提醒你，大約三個月後。",
            "上一步", "下一步",
            "改提醒間隔或時刻",
        ])
        XCTAssertEqual(screen.buttons.map(\.action), [.back, .toFinish])
        XCTAssertEqual(screen.links.map(\.action), [.adjustReminder])
        try CopyDocument.load().check(screen)
    }

    func testAPickedDaySaysNotHowFarOff() throws {
        let oneMonth = ReminderSettings(interval: .weeks4, time: TimeOfDay(hour: 7, minute: 5), next: Day(2027, 1, 1))
        XCTAssertEqual(screens.remind(.on(oneMonth, counted: false), notAfter: nil).texts[2], "這支手機會在 2027-01-01（星期五）上午 7:05 提醒你。")
        XCTAssertEqual(screens.remind(.on(oneMonth, counted: true), notAfter: nil).texts[2], "這支手機會在 2027-01-01（星期五）上午 7:05 提醒你，大約一個月後。")
    }

    /// The system does not let the app notify: why nothing was set, and the way to its settings.
    func testStepSevenWhenTheSystemSaidNo() throws {
        let screen = screens.remind(.refused, notAfter: "270115155959")
        XCTAssertEqual(screen.texts, [
            "提醒我回來過卡",
            "沒有排提醒：手機不允許這個 app 發通知。請允許通知設定，我們不會在沒有經過你同意的情況下打擾你。",
            "上一步", "打開通知設定",
            "這次不要",
        ])
        XCTAssertEqual(screen.buttons.map(\.action), [.back, .openNotificationSettings])
        XCTAssertEqual(screen.links.map(\.action), [.toFinish])
        try CopyDocument.load().check(screen)
    }

    /// The certificate ends before the reminder's day: said under the day;
    /// the day it ends in Taiwan, from its UTC time.
    func testACertificateEndingBeforeTheReminderIsSaid() throws {
        let ending = "這張自然人憑證在 2027-01-15 到期，比下次提醒早。到期之後要展期或換新卡，才能再過卡。"
        func last(_ reminder: DoneReminder, _ notAfter: String?) -> [String] { screens.remind(reminder, notAfter: notAfter).blocks.last?.texts ?? [] }
        XCTAssertEqual(last(.ask(threeMonths), "270115155959"), [ending])
        XCTAssertEqual(last(.on(threeMonths, counted: true), "270114170000"), [ending])
        // On the reminder's day or after it, or not read: nothing.
        for (reminder, notAfter) in [(DoneReminder.on(threeMonths, counted: true), "270208155959"), (.ask(threeMonths), "310101155959"), (.ask(threeMonths), nil)] as [(DoneReminder, String?)] {
            XCTAssertFalse(screens.remind(reminder, notAfter: notAfter).texts.contains { $0.contains("到期") })
        }
        try CopyDocument.load().check(screens.remind(.ask(threeMonths), notAfter: "270115155959"))
    }

    // Step 8: done, and sharing -----------------------------------------------------------------

    /// The last step of a first declaration, word for word as card-proof.md writes it for the app.
    func testStepEightOfAFirstDeclaration() throws {
        let screen = screens.finish(done([row("threads", "first", "alice")], [recorded("threads", "first", "alice")], firstRecord: true), single: "Threads")
        XCTAssertEqual(screen.step, 8)
        XCTAssertEqual(screen.texts, [
            "恭喜你完成島民證明",
            "島民證明", "@alice", "島民編號 7K2Q9FM4XD 開頭",
            "這是第 128 張島民證明。", "愈多人成為島民，知道彼此都是台灣人，我們能讓台灣的網路討論變得更貼近真實、更有意義。",
            "謝謝你加入島民，誠摯的邀請你分享島民證明。",
            "分享到 Threads", "上一步", "完成",
        ])
        // The main button alone on top: sharing; under it back to step 7 and done (to step 1), side by side
        // (card-proof.md, step 8, app).
        XCTAssertTrue(inline(screen).isEmpty)
        XCTAssertEqual(screen.top?.action, .share)
        XCTAssertFalse(screen.mainButton)
        XCTAssertEqual(screen.buttons.map(\.action), [.back, .restart])
        XCTAssertEqual(screen.settings, Button(label: "設定", action: .openSettings))
        try CopyDocument.load().check(screen)
    }

    /// No ordinal in the answer: the paragraph starts at the invitation.
    func testStepEightWithoutAnOrdinal() {
        let screen = screens.finish(done([row("threads", "refresh", "alice", current: "alice")], [recorded("threads", "refresh", "alice")], ordinal: nil), single: "Threads")
        XCTAssertTrue(screen.blocks.contains(.sentences([copy("finish.invite")])))
        let thousands = screens.finish(done([row("threads", "refresh", "alice", current: "alice")], [recorded("threads", "refresh", "alice")], ordinal: 1284), single: "Threads")
        XCTAssertTrue(thousands.texts.contains("這是第 1,284 張島民證明。"))
    }

    func testTheTextSuggestedForSharingTheOrdinalWithACommaEveryThreeDigitsOrTheSentenceWithoutANumber() {
        let expected = [row("threads", "refresh", "alice", current: "alice")]
        let text = { (ordinal: Int?) in self.screens.shareText(self.done(expected, [self.recorded("threads", "refresh", "alice")], ordinal: ordinal)) }
        XCTAssertEqual(text(1), "我剛剛換了第 1 張島民證明，宣告本帳號背後是一名台灣人。")
        XCTAssertEqual(text(999), "我剛剛換了第 999 張島民證明，宣告本帳號背後是一名台灣人。")
        XCTAssertEqual(text(1284), "我剛剛換了第 1,284 張島民證明，宣告本帳號背後是一名台灣人。")
        XCTAssertEqual(text(1_234_567), "我剛剛換了第 1,234,567 張島民證明，宣告本帳號背後是一名台灣人。")
        XCTAssertEqual(text(nil), "我剛剛換了一張島民證明，宣告本帳號背後是一名台灣人。")
        // Nothing of the answer told: no ordinal either.
        XCTAssertEqual(screens.shareText(done(expected, nil, seq: nil)), "我剛剛換了一張島民證明，宣告本帳號背後是一名台灣人。")
    }

    /// The titles of the last step, by what this card proof did (card-proof.md, step 8, the table).
    func testTheTitlesByWhatTheServerRecorded() throws {
        let unchanged = [row("threads", "refresh", "alice", current: "alice")]
        func title(_ done: Flow.Done, single: String? = "Threads") -> String? { self.title(of: screens.finish(done, single: single)) }
        // The four the cardholder meets: a new declaration, a card proof again, a switch, everything withdrawn.
        XCTAssertEqual(title(done([row("threads", first, "alice")], [recorded("threads", first, "alice")], firstRecord: true)), "恭喜你完成島民證明")
        XCTAssertEqual(title(done(unchanged, [recorded("threads", "refresh", "alice")])), "島民證明已更新")
        XCTAssertEqual(title(done([row("threads", "switch", "carol.tw", current: "alice", previous: "alice")], [recorded("threads", "switch", "carol.tw")])), "島民證明換成 @carol.tw 了")
        XCTAssertEqual(title(done([row("threads", "withdraw", "alice", current: "alice")], [recorded("threads", "withdraw", "alice", 0)])), "已全部收回")
        // Declared again after everything was withdrawn.
        XCTAssertEqual(title(done([row("threads", "refresh", "alice")], [recorded("threads", "refresh", "alice")])), "恭喜你完成島民證明")
        // More than one platform: the general title for anything but a first record and a card proof again.
        XCTAssertEqual(title(done([row("threads", "switch", "carol.tw", current: "alice", previous: "alice")], [recorded("threads", "switch", "carol.tw")]), single: nil), copy("done.changed"))
        // The server recorded a switch where the screen said nothing changes: not "unchanged".
        XCTAssertEqual(title(done(unchanged, [recorded("threads", "switch", "alice")], mismatches: ["threads"])), "島民證明換成 @alice 了")
        // Kinds not read: only that it was recorded, also on a card's first record.
        XCTAssertEqual(title(done(unchanged, nil)), copy("done.recorded_only"))
        XCTAssertEqual(title(done([row("threads", first, "alice")], nil, firstRecord: true, seq: nil)), copy("done.recorded_only"))
        for finished in [done(unchanged, [recorded("threads", "refresh", "alice")]), done([row("threads", "switch", "carol.tw", current: "alice", previous: "alice")], [recorded("threads", "switch", "carol.tw")])] {
            try CopyDocument.load().check(screens.finish(finished, single: "Threads"))
        }
    }

    /// More than one platform: the card names each account's platform.
    func testTheCardNamesThePlatformsWhenThereIsMoreThanOne() {
        let expected = [row("test-example", "withdraw", "a-b", current: "a-b", known: false), row("threads", "refresh", "alice", current: "alice")]
        let screen = screens.finish(done(expected, [recorded("test-example", "withdraw", "a-b", 0), recorded("threads", "refresh", "alice")]), single: nil)
        let cards = screen.blocks.compactMap { block -> ProofCard? in if case .proofCard(let card) = block { return card } else { return nil } }
        XCTAssertEqual(cards.map(\.rows), [[ProofCard.Row(name: "Threads", account: "@alice")]])
    }

    /// Everything withdrawn: no card, nothing to share, no way back; the link can be taken down.
    func testEveryAccountWithdrawnNoCardNothingToShareNoWayBack() throws {
        let withdrawn = done([row("threads", "withdraw", "alice", current: "alice")], [recorded("threads", "withdraw", "alice", 0)])
        let screen = screens.finish(withdrawn, single: "Threads")
        XCTAssertEqual(screen.step, 8)
        XCTAssertEqual(screen.texts, [
            "已全部收回",
            "2026-11-16 記進了證明紀錄。",
            "你可以拿掉 Threads 個人檔案上的證明連結。",
            "完成",
        ])
        XCTAssertEqual(screen.buttons, [Button(label: "完成", action: .restart)])
        XCTAssertTrue(screen.mainButton)
        try CopyDocument.load().check(screen)
        // More than one platform.
        XCTAssertTrue(screens.finish(withdrawn, single: nil).texts.contains("已經收回的帳號，個人檔案上的連結可以拿掉。"))
        // Recorded as something else than step 5 said: said first, and the record under it, on this step.
        let other = screens.finish(done([row("threads", "withdraw", "alice", current: "alice")], [recorded("threads", "withdraw", "bob", 0)], mismatches: ["threads"]), single: "Threads")
        XCTAssertEqual(other.blocks.first, .message(copy("done.mismatch")))
        XCTAssertEqual(try record(of: other)[1], [copy("done.record_withdraw_all")])
    }

    /// The times of day, as design/copy/app.md writes them.
    func testTheTimesOfDay() throws {
        let when = When(appCopy: Copy(json: try Repository.data("design/copy/app.json")))
        XCTAssertEqual(when.time(TimeOfDay(hour: 0, minute: 30)), "上午 12:30")
        XCTAssertEqual(when.time(TimeOfDay(hour: 11, minute: 59)), "上午 11:59")
        XCTAssertEqual(when.time(TimeOfDay(hour: 12, minute: 0)), "下午 12:00")
        XCTAssertEqual(when.time(TimeOfDay(hour: 17, minute: 59)), "下午 5:59")
        XCTAssertEqual(when.time(TimeOfDay(hour: 18, minute: 0)), "晚上 6:00")
        XCTAssertEqual(when.time(.evening), "晚上 9:00")
        XCTAssertEqual(when.day(Day(2027, 2, 14)), "2027-02-14（星期日）")
        XCTAssertEqual(when.day(Day(2027, 2, 13)), "2027-02-13（星期六）")
    }
}
