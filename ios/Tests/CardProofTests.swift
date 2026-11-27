import UIKit
import XCTest
@testable import IamrealApp

/// Card proofs from the screens, with a card made of test keys, against
/// the Worker in the local workerd (web/test/app-backend.ts): what the
/// screens of the eight steps say, what goes to the card, and what the proof log then holds,
/// which the script has Go's iamreal-verify re-verify once these tests end.
///
/// The model is driven the way the screen drives it: a button is pressed by
/// the words on it, so a button the screen does not show cannot be pressed.
@MainActor
final class CardProofTests: XCTestCase {
    private var backend: TestBackend!
    private var card: FakeCard!
    /// The device's clock.
    private var now = Date()
    /// What the app opened outside itself, and what it put on the clipboard.
    private var opened: [URL] = []
    private var copied: [String] = []
    private var shared: [String] = []
    /// The back end of the model made last, which counts what it is asked.
    private var asked: CountingBackend!
    private var document: CopyDocument!
    /// The values of this run that stand where the document has an example.
    private var values: [String: String] = [:]
    /// The system's notifications and what the phone keeps of the reminder, for the model made last.
    private var notifier: FakeNotifier!
    private var reminderStore: MemoryReminderStore!
    private var reminders: Reminders!
    /// How many times the app opened the system's settings at its notifications.
    private var notificationSettingsOpened = 0
    /// What the lowest version says of the build, when a test changes it under a model.
    private var minApp: MinApp?
    /// The counts the models of a test sent, read, in the order they were sent (#434); and the card proof device ID as the
    /// phone keeps it, the same for every model of a test, as for one phone.
    private var countsSent: [[String: String]] = []
    private var deviceIDStored: String?
    /// The record bodies every model of a test sent.
    private var submitted: [Data] = []

    override func setUp() async throws {
        backend = try TestBackend.load()
        card = FakeCard(certificates: backend.certificates, privateKey: backend.privateKey, pin: backend.pin)
        now = backend.start
        document = try CopyDocument.load()
        values = ["測試用戶": "王小明", backend.origin.host ?? "": "iamreal.tw"]
    }

    // The four kinds, one card ------------------------------------------------------

    /// A first declaration, a card proof again, a switch and a withdrawal,
    /// in that order: the proof log then holds `first`, `refresh`, `switch`,
    /// `withdraw` on Threads. The switch is on the next day: on the day of
    /// the declaration it would be a correction.
    func testACardDeclaresComesAgainSwitchesAndWithdraws() async throws {
        try await backend.setClock(now)
        // Card proofs stopped and taken again (#394, #402): the first declaration is the card proof that goes through after.
        try await cardProofsStopped()
        try await declares()
        try await comesAgain()
        now = backend.start.addingTimeInterval(24 * 3600)
        try await backend.setClock(now)
        try await switchesWithAnotherCardInTheWay()
        try await withdraws()
        countsChecked()
    }

    /// What the counts of the four card proofs say (#434; spec/counts.md): every count is the iOS app's, with the members
    /// of the table only and nothing of the card or the accounts; each card proof that was done sent every step once and
    /// the three durations, and did not stop; the card proofs stopped sent server_paused, another card at a tap other_card;
    /// every record sent carried the card proof device ID the counts carry.
    private func countsChecked() {
        let members: Set<String> = ["client", "event", "step", "reason", "action", "tap", "took", "device_id", "attempt_id", "os_version", "app_version", "model"]
        XCTAssertFalse(countsSent.isEmpty)
        for count in countsSent {
            XCTAssertEqual(count["client"], "ios")
            XCTAssertTrue(Set(count.keys).isSubset(of: members), "\(count)")
            XCTAssertNotNil(count["os_version"], "the system's version: \(count)")
            XCTAssertNotNil(count["model"].flatMap { $0.range(of: #"^[A-Za-z0-9 \-_.,()+]{1,32}$"#, options: .regularExpression) }, "the model: \(count)")
            for never in ["alice", "bob", "carol", backend.pin, "測試用戶"] {
                XCTAssertFalse(count.values.contains { $0.contains(never) }, "\(never) in \(count)")
            }
        }
        var attempts: [String: [[String: String]]] = [:]
        var order: [String] = []
        for count in countsSent {
            let id = count["attempt_id"] ?? ""
            if attempts[id] == nil { order.append(id) }
            attempts[id, default: []].append(count)
        }
        for counts in attempts.values { XCTAssertEqual(Set(counts.map { $0["device_id"] }).count, 1) }
        let steps = ["open", "read", "config", "certificates", "certificate", "crl", "tree", "circuit", "engine", "checked", "pin", "scope_signed", "state", "chosen", "confirmed", "challenge", "code_signed", "proved", "done"]
        let done = order.compactMap { attempts[$0] }.filter { $0.contains { $0["event"] == "step" && $0["step"] == "done" } }
        XCTAssertEqual(done.count, 4)
        for counts in done {
            let reached = counts.filter { $0["event"] == "step" }.compactMap { $0["step"] }
            // `open` is step 1's: a card proof begun again while step 1 stayed has none of its own.
            let expected = reached.first == "open" ? steps : steps.filter { $0 != "open" }
            XCTAssertEqual(reached.sorted(), expected.sorted(), "\(reached)")
            XCTAssertEqual(reached.last, "done")
            XCTAssertEqual(Set(counts.filter { $0["event"] == "duration" }.compactMap { $0["step"] }), ["crl", "tree", "proved"])
            XCTAssertFalse(counts.contains { $0["event"] == "stop" })
        }
        let said = Set(countsSent.compactMap { c -> String? in
            guard let event = c["event"], event == "stop" || event == "retry" else { return nil }
            return "\(event):\(c["reason"] ?? "")"
        })
        // Stopped (#394), another card at a tap, and too many people (#420): the start turned away twice, the card's state,
        // the challenge and the record turned away once each, and the record sent again.
        for expected in ["stop:server_paused", "retry:other_card", "stop:server_busy", "stop:server_rate_limited", "retry:server_busy", "retry:server_rate_limited"] {
            XCTAssertTrue(said.contains(expected), "\(expected) not in \(said)")
        }
        XCTAssertTrue(countsSent.contains { $0["event"] == "action" && $0["action"] == "resubmit" })
        let ids = Set(countsSent.compactMap { $0["device_id"] })
        XCTAssertEqual(ids.count, 1)
        let records = submitted + (asked?.submitted ?? [])
        XCTAssertGreaterThanOrEqual(records.count, 4)
        for body in records {
            let sent = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            XCTAssertEqual(sent?["device_id"] as? String, ids.first)
        }
    }

    private func declares() async throws {
        // As the app starts: the screen is drawn, and nothing has been pressed.
        let model = makeModel(opened: false)
        XCTAssertEqual(asked.configRequests, 0)
        await Snapshot.save(model, as: "1-before")
        XCTAssertEqual(asked.configRequests, 1, "the app asks for config when it opens, before any card is read")
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertEqual(model.screen.texts, [
            "開始之前",
            "請準備好你的實體自然人憑證卡片。",
            "非本國國民持有的自然人憑證無法用於島民證明。",
            "為什麼一定要實體的卡片？",
            "實體卡片簽章在卡片裡完成，卡片效期約 5 ~ 8 年。",
            "行動自然人憑證簽章依賴內政部伺服器，而且每年會更換金鑰，不適合作為島民證明使用。",
            "還沒有自然人憑證，怎麼申辦？",
            "滿 18 歲，未受監護宣告，本人攜帶身分證到戶政事務所臨櫃申辦，當場拿到卡片，費用 250 元。",
            "找附近的戶政事務所",
            "內政部憑證管理中心：申辦資格、時間地點、攜帶項目（moica.nat.gov.tw）",
            "下一步",
        ])
        // The two ways to a card: the phone's map, and MOICA's page on applying. Nothing of the app goes with them.
        try await press("找附近的戶政事務所", in: model)
        XCTAssertEqual(opened.last?.absoluteString.removingPercentEncoding, "https://maps.apple.com/?q=戶政事務所")
        try await press("內政部憑證管理中心：申辦資格、時間地點、攜帶項目（moica.nat.gov.tw）", in: model)
        XCTAssertEqual(opened.last?.absoluteString, "https://moica.nat.gov.tw/rac.html")
        XCTAssertEqual(model.screen.step, 1)

        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertEqual(model.screen.texts, [
            "讀取卡片",
            "按「感應卡片」，再把自然人憑證平貼在手機背面的上方，不要移動，直到畫面說可以拿開。",
            // The demonstration of where the card goes: what VoiceOver reads in its place, and its button. It plays
            // as the step comes up.
            "示範：手機正面朝你，不用翻面。把自然人憑證貼到手機背面的上方，停住不動。",
            "停止",
            "連上島民證明的伺服器",
            "感應卡片，讀取卡片上的憑證",
            "檢查憑證",
            "下載內政部的廢止清冊，確認憑證沒有被廢止",
            "上一步",
            "感應卡片",
        ])

        // Its button stops it, at rest with the card in place, and then plays it again; its three rounds over, as
        // the picture tells it, it is at rest again.
        XCTAssertEqual(senseDemonstration(on: model.screen)?.description, Copy.bundled()("app_demo.sense_iphone"))
        XCTAssertEqual(senseDemonstration(on: model.screen)?.playing, true)
        try await press("停止", in: model)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.control.label, Copy.bundled()("app_demo.replay"))
        XCTAssertEqual(senseDemonstration(on: model.screen)?.played, true)
        try await press("再看一次", in: model)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.control.label, Copy.bundled()("app_demo.stop"))
        model.perform(.stopDemo)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.playing, false)
        try await press("再看一次", in: model)

        try await press("感應卡片", in: model)
        XCTAssertEqual(model.screen.texts, [
            "讀取卡片",
            "可以把卡片拿開了。",
            "連上島民證明的伺服器", "完成",
            "感應卡片，讀取卡片上的憑證", "完成",
            "檢查憑證", "完成",
            "下載內政部的廢止清冊，確認憑證沒有被廢止", "完成",
            "下一步",
        ])
        XCTAssertEqual(card.taps, [.readCertificates])
        XCTAssertEqual(card.pinsReceived, 0, "the first tap takes no PIN")
        await Snapshot.save(model, as: "2-read")

        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 3)
        XCTAssertEqual(model.screen.texts, [
            "輸入 PIN",
            "已讀到卡片", "測試用戶", "（姓名只顯示在這裡，不會送出。）",
            "PIN",
            "按下確認後，卡片會簽章一次，用來查詢這張卡片目前宣告的帳號。",
            "PIN、姓名和憑證、卡片的簽章不會離開這支手機。",
            "上一步",
            "確認卡片",
        ])
        await Snapshot.save(model, as: "3-pin")

        // Without a PIN there is no tap.
        try await press("確認卡片", in: model)
        XCTAssertTrue(model.screen.texts.contains("請輸入 PIN。"))
        XCTAssertEqual(card.taps, [.readCertificates])

        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertEqual(model.pinText, "", "the field no longer holds the PIN")
        XCTAssertEqual(card.taps, [.readCertificates, .sign])
        XCTAssertEqual(model.screen.texts, [
            "你的 Threads 帳號",
            "這張卡片還沒有宣告過帳號。",
            "填上你要宣告的 Threads 帳號。",
            "Threads", "預覽",
            "預覽會在 Threads 或瀏覽器打開個人檔案，讓你確認沒有打錯。",
            "下一步",
            "取消",
        ])
        await Snapshot.save(model, as: "4-accounts")

        // An empty list for a card that declares nothing, then an account that is not in Threads' format.
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertTrue(model.screen.texts.contains("請至少填一個帳號。"))
        model.type("alice!", on: "threads")
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertTrue(model.screen.texts.contains("帳號只能用英文小寫、數字、句點和底線，最多 30 個字。"))

        // As a cardholder would type it: the app tidies it.
        model.type("@Alice", on: "threads")
        try await press("預覽", in: model)
        XCTAssertEqual(opened.last?.absoluteString, "https://www.threads.com/@alice")
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 5)
        let shortID = try shortID(on: model.screen)
        let today = CardProofFlow.dateInTaiwan(now)
        XCTAssertEqual(model.screen.texts, [
            "確認",
            "按下後，證明紀錄會記下新的證明並公開給所有人：",
            "Threads", "@alice", "新宣告",
            "日期", today,
            "島民編號", "\(shortID) 開頭",
            "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。",
            "持有這張卡片和 PIN 的人，都能查詢、更新、收回或更換這張證明宣告的 Threads 帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
            "上一步",
            "宣告這個帳號",
            "取消",
        ])
        XCTAssertTrue(model.holdsPIN, "the PIN waits in memory for the third tap")
        await Snapshot.save(model, as: "5-confirm")

        try await press("宣告這個帳號", in: model)
        // Step 6: the link, to hang on the profile.
        XCTAssertEqual(model.screen.step, 6)
        let link = "\(try XCTUnwrap(backend.origin.host))/p/\(shortID)"
        XCTAssertEqual(model.screen.texts, [
            "\(today) 記進了證明紀錄。",
            "把證明掛上你的 Threads 個人檔案",
            "在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。",
            link,
            "複製證明連結",
            "打開 Threads",
            "示範：按「複製證明連結」，到 Threads 的個人檔案按「編輯個人檔案」、「連結」、「新增連結」，貼上網址後按「完成」，個人檔案上多了一行連結。",
            "再看一次",
            "按「編輯個人檔案」", "按「連結」", "按「新增連結」", "在「網址」貼上剛才複製的連結，按右上角的「完成」",
            "如果你換了新的自然人憑證，請把個人檔案的連結換成新的連結。",
            "掛好了嗎？打開你的島民證明看看。",
            "頁面上的個人檔案裡看得到這個連結，就成功了。",
            "下一步",
        ])
        await Snapshot.save(model, as: "6-hang")
        // The two buttons are side by side, above the demonstration.
        XCTAssertTrue(model.screen.blocks.contains(.sideBySide([
            Button(label: "複製證明連結", action: .copyLink),
            Button(label: "打開 Threads", action: .openProfile("threads"), spoken: "打開 @alice 的 Threads 個人檔案"),
        ])))
        // The demonstration, with this card's account and the address of its page. It plays when its picture
        // comes onto the screen (the picture then asks for it, as here): its button stops it, at its last
        // frame, and then plays it again.
        let demo = try XCTUnwrap(demonstration(on: model.screen))
        XCTAssertEqual(demo.account, "@alice")
        XCTAssertEqual(demo.link, link)
        XCTAssertEqual(demo.description, Copy.bundled()("app_demo.hang"))
        XCTAssertEqual(demonstration(on: model.screen)?.played, false)
        model.perform(.showDemo)
        XCTAssertEqual(demonstration(on: model.screen)?.control.label, Copy.bundled()("app_demo.stop"))
        try await press("停止", in: model)
        XCTAssertEqual(demonstration(on: model.screen)?.control.label, Copy.bundled()("app_demo.replay"))
        XCTAssertEqual(demonstration(on: model.screen)?.playing, false)
        XCTAssertEqual(demonstration(on: model.screen)?.played, true, "at its last frame")
        try await press("再看一次", in: model)
        XCTAssertEqual(demonstration(on: model.screen)?.playing, true)
        // Its end, as the picture tells it.
        model.perform(.stopDemo)
        XCTAssertEqual(demonstration(on: model.screen)?.control.label, "再看一次")

        // When it opened, and by the reading after 下一步, whose own request had the mark of a start (docs/api/card-proof.md, `config`).
        XCTAssertEqual(asked.configRequests, 2, "the app asked for config when it opened, and the reading asked again")
        XCTAssertEqual(asked.startRequests, 1, "下一步 asked for config with the mark of a start, once")
        // The card was tapped three times and signed twice; the PIN is gone.
        XCTAssertEqual(card.taps, [.readCertificates, .sign, .sign])
        XCTAssertEqual(card.signatures, 2)
        XCTAssertFalse(model.holdsPIN)

        // The link, copied whole; the card's page, in the browser; the account on Threads.
        let address = backend.origin.appendingPathComponent("p").appendingPathComponent(shortID)
        try await press("複製證明連結", in: model)
        XCTAssertEqual(copied, [address.absoluteString])
        XCTAssertTrue(model.screen.texts.contains("已複製"))
        try await press("打開你的島民證明", in: model)
        XCTAssertEqual(opened.last, address)
        let (page, response) = try await URLSession.shared.data(from: address)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let html = String(decoding: page, as: UTF8.self)
        XCTAssertTrue(html.contains("@alice"), "the card's page lists the account")
        // The card's ordinal as its page writes it: the proof log's, which the answer to the submission gave the app.
        let ordinal = try XCTUnwrap(
            html.range(of: #"(?<=<p class="ordinal">第 )[0-9,]+(?= 張島民證明</p>)"#, options: .regularExpression).map { String(html[$0]) },
            "the card's page writes its ordinal")
        try await press("打開 Threads", in: model)
        XCTAssertEqual(opened.last?.absoluteString, "https://www.threads.com/@alice")

        // Step 7: the reminder, offered: three months from today, 9:00 in the evening.
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 7)
        let offered = [
            "提醒我回來過卡",
            "建議定期更新島民證明，增加說服力。",
            "這支手機會在 \(When(appCopy: Copy.bundled("app")).day(Day(now).adding(days: 84)))晚上 9:00 提醒你，大約三個月後。",
        ]
        XCTAssertEqual(model.screen.texts, offered + ["上一步", "開啟提醒", "改提醒間隔或時刻", "這次不要"])
        await Snapshot.save(model, as: "7-reminder")
        // Back to step 6, as it was left, and on again. The demonstration does not play by itself a second time.
        try await press("上一步", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertTrue(model.screen.texts.contains("已複製"))
        model.perform(.showDemo)
        XCTAssertEqual(demonstration(on: model.screen)?.playing, false)
        XCTAssertEqual(demonstration(on: model.screen)?.played, true)
        try await press("下一步", in: model)

        // The system does not let the app notify: nothing is set, and the step says why.
        notifier.allows = false
        try await press("開啟提醒", in: model)
        XCTAssertEqual(model.screen.step, 7)
        XCTAssertEqual(model.screen.texts, [
            "提醒我回來過卡",
            "沒有排提醒：手機不允許這個 app 發通知。請允許通知設定，我們不會在沒有經過你同意的情況下打擾你。",
            "上一步", "打開通知設定",
            "這次不要",
        ])
        XCTAssertNil(reminderStore.kept)
        XCTAssertEqual(notifier.scheduled, [])
        await Snapshot.save(model, as: "7-refused")
        // Back in the app with nothing changed in the settings: the same screen.
        try await press("打開通知設定", in: model)
        XCTAssertEqual(notificationSettingsOpened, 1)
        model.cameBack()
        while let work = model.work { await work.value }
        XCTAssertTrue(model.screen.texts.contains("打開通知設定"))
        XCTAssertNil(reminderStore.kept)
        // "這次不要", then back from the last step: asked again as step 7 comes up, and still refused.
        try await press("這次不要", in: model)
        XCTAssertEqual(model.screen.step, 8)
        try await press("上一步", in: model)
        XCTAssertTrue(model.screen.texts.contains("打開通知設定"))
        XCTAssertNil(reminderStore.kept)
        // Allowed in the settings: back in the app the reminder is set as offered, and the step says when.
        notifier.allows = true
        model.cameBack()
        while let work = model.work { await work.value }
        XCTAssertEqual(model.screen.step, 7)
        XCTAssertEqual(model.screen.texts, offered + ["上一步", "下一步", "改提醒間隔或時刻"])
        XCTAssertEqual(reminderStore.kept, ReminderSettings(interval: .weeks12, time: .evening, next: Day(now).adding(days: 84)))
        XCTAssertEqual(notifier.scheduled.count, 1)

        // Step 8: done, and the invitation to share.
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 8)
        XCTAssertEqual(model.screen.texts, [
            "恭喜你完成島民證明",
            "島民證明", "@alice", "島民編號 \(shortID) 開頭",
            "這是第 \(ordinal) 張島民證明。", "愈多人成為島民，知道彼此都是台灣人，我們能讓台灣的網路討論變得更貼近真實、更有意義。",
            "謝謝你加入島民，誠摯的邀請你分享島民證明。",
            "分享到 Threads",
            "上一步", "完成",
        ])
        await Snapshot.save(model, as: "8-done")
        // The share sheet, with the sentence and the card's page.
        try await press("分享到 Threads", in: model)
        let words = Copy(json: try Repository.data("design/copy/card-proof.json"))
        XCTAssertEqual(shared, ["\(words("done.share_text", ["ordinal": ordinal]))\n\(address.absoluteString)"])
        // Back to step 7 and on again: nothing touches the card.
        try await press("上一步", in: model)
        XCTAssertEqual(model.screen.step, 7)
        try await press("下一步", in: model)
        XCTAssertEqual(card.taps, [.readCertificates, .sign, .sign])

        try await press("完成", in: model)
        XCTAssertEqual(model.screen.step, 1)
    }

    private func comesAgain() async throws {
        let model = makeModel()
        // Too many people on the way (#420): step 1, the reading's config, and the card's state turned away.
        try await tooManyToTheList(model)
        // The account is not typed again: the main button is the card proof again.
        XCTAssertEqual(model.screen.texts, [
            "你的 Threads 帳號",
            "這張卡片目前宣告：",
            "@alice",
            "上次過卡是今天",
            "更新島民證明",
            "宣告帳號不變，把島民證明上的日期更新成今天。",
            "改成別的帳號",
            "收回對 @alice 的宣告",
            "取消",
        ])
        XCTAssertNil(typed(in: model), "no field")
        await Snapshot.save(model, as: "4-declared")

        try await press("更新島民證明", in: model)
        XCTAssertEqual(model.screen.step, 5)
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@alice", "不變"]])
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "更新島民證明"])
        // Back: the screen the button was pressed on.
        try await press("上一步", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertTrue(model.screen.texts.contains("這張卡片目前宣告："))
        try await press("更新島民證明", in: model)

        // The reminder is on, as a cardholder who turned it on the last time has it.
        await reminders.turnOn(interval: .weeks12, time: .evening)
        // The challenge and the record turned away (#420): each is asked again, the card tapped once at step 5.
        try await tooManyAtStepFive(model, button: "更新島民證明")
        XCTAssertFalse(model.holdsPIN)
        // Step 6, the short one: only whether the link is still there.
        XCTAssertEqual(model.screen.step, 6)
        let shortID = try XCTUnwrap(shortIDInTheLink(on: model.screen))
        XCTAssertEqual(model.screen.texts, [
            "\(CardProofFlow.dateInTaiwan(now)) 記進了證明紀錄。",
            "你的 Threads 個人檔案上，還有這個連結嗎？",
            "\(try XCTUnwrap(backend.origin.host))/p/\(shortID)",
            "打開你的島民證明看看。",
            "在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。",
            "沒有看到連結，重新掛上",
            "下一步",
        ])
        await Snapshot.save(model, as: "6-hang-short")
        // "沒有看到連結，重新掛上": the whole step, still step 6.
        try await press("沒有看到連結，重新掛上", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertTrue(model.screen.texts.contains("把證明掛上你的 Threads 個人檔案"))
        XCTAssertTrue(model.screen.texts.contains("複製證明連結"))
        XCTAssertFalse(model.screen.texts.contains { $0.hasPrefix("如果你換了新的自然人憑證") })

        // Step 7: the reminder is on, set again from today as last chosen; no way to say no here.
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 7)
        XCTAssertEqual(model.screen.texts, [
            "提醒我回來過卡",
            "建議定期更新島民證明，增加說服力。",
            "這支手機會在 \(When(appCopy: Copy.bundled("app")).day(Day(now).adding(days: 84)))晚上 9:00 提醒你，大約三個月後。",
            "上一步", "下一步",
            "改提醒間隔或時刻",
        ])
        await Snapshot.save(model, as: "7-reminder-on")

        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 8)
        XCTAssertEqual(title(of: model.screen), "島民證明已更新")
        XCTAssertEqual(proofCard(on: model.screen)?.rows, [ProofCard.Row(name: nil, account: "@alice")])
        try await press("完成", in: model)
        XCTAssertEqual(model.screen.step, 1)
    }

    /// Before the second and the third tap the cardholder picks up another
    /// card: the app compares the certificates first, and the PIN never
    /// reaches that card.
    private func switchesWithAnotherCardInTheWay() async throws {
        let other = FakeCard(certificates: [Data([0x30, 0x03, 0x02, 0x01, 0x01])], privateKey: backend.privateKey, pin: backend.pin)
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)

        card.nextTapFinds = other
        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 3)
        XCTAssertTrue(model.screen.texts.contains("這不是剛才讀到的那張卡片，PIN 沒有送出。請換回剛才那張卡片，再感應一次。"))
        XCTAssertEqual(model.screen.buttons.map(\.label), ["再感應一次"])
        XCTAssertEqual(other.taps, [.sign])
        XCTAssertEqual(other.pinsReceived, 0, "the PIN did not go to the other card")
        XCTAssertTrue(model.holdsPIN, "the PIN is kept for the tap to be made again")
        await Snapshot.save(model, as: "3-other-card")

        try await press("再感應一次", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertEqual(Array(model.screen.texts.prefix(4)), ["你的 Threads 帳號", "這張卡片目前宣告：", "@alice", "上次過卡是 1 天前"])

        try await press("改成別的帳號", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertEqual(model.screen.texts, [
            "你的 Threads 帳號",
            "這張卡片目前宣告 @alice。",
            "改成別的帳號",
            "Threads", "預覽",
            "改了之後，@alice 不再是這張卡片宣告的帳號。", "一張卡終身最多更換 5 次，這次之後還可以更換 4 次。",
            "預覽會在 Threads 或瀏覽器打開個人檔案，讓你確認沒有打錯。",
            "下一步",
            "不改了",
            "取消",
        ])
        XCTAssertEqual(typed(in: model), "", "the field starts empty")
        await Snapshot.save(model, as: "4-switch")
        // An empty field goes nowhere: withdrawing is the other action.
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertTrue(model.screen.texts.contains("請至少填一個帳號。"))
        // The account it declares now, typed again: the card proof again, as "更新島民證明".
        model.type("@Alice", on: "threads")
        try await press("下一步", in: model)
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@alice", "不變"]])
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "更新島民證明"])
        try await press("上一步", in: model)
        // "不改了": what the card declares again; then to the field once more.
        try await press("不改了", in: model)
        XCTAssertTrue(model.screen.texts.contains("更新島民證明"))
        try await press("改成別的帳號", in: model)

        model.type("carol.tw", on: "threads")
        try await press("下一步", in: model)
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@carol.tw", "更換，原本是 @alice。", "用掉一次更換，不會恢復。之後還可以更換 4 次。"]])
        // Back: the field as it was typed.
        try await press("上一步", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertEqual(typed(in: model), "carol.tw")
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "宣告這個帳號"])

        card.nextTapFinds = other
        try await press("宣告這個帳號", in: model)
        XCTAssertEqual(model.screen.step, 5)
        XCTAssertEqual(model.screen.texts, [
            "進行中",
            "請不要關閉 app，也不要切到別的 app。",
            "連上島民證明的伺服器", "完成",
            "感應卡片，卡片簽章", "停在這裡",
            "這不是一開始讀到的那張卡片，PIN 沒有送出。請換回那張卡片，再感應一次。",
            "正在這支手機計算，產生零知識證明，大約 5 秒",
            "送出",
            "再感應一次",
            "取消",
        ])
        XCTAssertEqual(other.pinsReceived, 0, "the PIN did not go to the other card")
        await Snapshot.save(model, as: "5-other-card")

        try await press("再感應一次", in: model)
        XCTAssertEqual(card.signatures, 6, "two signatures for each of the three card proofs so far")
        XCTAssertFalse(model.holdsPIN)
        // Another account: the whole of step 6, for the new account's profile.
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertTrue(model.screen.texts.contains("把證明掛上你的 Threads 個人檔案"))
        XCTAssertTrue(model.screen.blocks.contains(.sideBySide([
            Button(label: "複製證明連結", action: .copyLink),
            Button(label: "打開 Threads", action: .openProfile("threads"), spoken: "打開 @carol.tw 的 Threads 個人檔案"),
        ])))
        XCTAssertFalse(model.screen.texts.contains { $0.hasPrefix("如果你換了新的自然人憑證") })
        // Step 7, asked again (nothing is kept on this phone), and "這次不要": nothing is kept, on to the last step.
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.links.map(\.label), ["改提醒間隔或時刻", "這次不要"])
        try await press("這次不要", in: model)
        XCTAssertNil(reminderStore.kept)
        XCTAssertEqual(notifier.asked, 0, "the system was not asked for notifications")
        XCTAssertEqual(model.screen.step, 8)
        XCTAssertEqual(title(of: model.screen), "島民證明換成 @carol.tw 了")
        XCTAssertEqual(proofCard(on: model.screen)?.rows, [ProofCard.Row(name: nil, account: "@carol.tw")])
        await Snapshot.save(model, as: "8-done-switch")
        try await press("完成", in: model)
        XCTAssertEqual(model.screen.step, 1)
    }

    private func withdraws() async throws {
        let model = makeModel()
        try await toAccounts(model)
        XCTAssertEqual(Array(model.screen.texts.prefix(4)), ["你的 Threads 帳號", "這張卡片目前宣告：", "@carol.tw", "上次過卡是今天"])
        // Changed today: changing it again today is not another switch.
        try await press("改成別的帳號", in: model)
        XCTAssertTrue(model.screen.texts.contains("今天才宣告的帳號，今天改掉不另外算一次更換。"))
        try await press("不改了", in: model)
        try await press("收回對 @carol.tw 的宣告", in: model)
        let shortID = try shortID(on: model.screen)
        XCTAssertEqual(model.screen.texts, [
            "確認",
            "按下後，證明紀錄會公開記下這張卡片不再宣告任何帳號：",
            "Threads", "@carol.tw", "收回",
            "日期", CardProofFlow.dateInTaiwan(now),
            "島民編號", "\(shortID) 開頭",
            "歷史證明紀錄無法刪除，依然看得出這張卡片過去曾宣告過的帳號。",
            "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。",
            "持有這張卡片和 PIN 的人，都能查詢或再宣告。",
            "上一步",
            "收回對 @carol.tw 的宣告",
            "取消",
        ])
        await Snapshot.save(model, as: "5-withdraw")

        try await press("收回對 @carol.tw 的宣告", in: model)
        // Everything withdrawn: from step 5 to the last step, with nothing to hang, to be reminded of or to share.
        XCTAssertEqual(model.screen.step, 8)
        XCTAssertEqual(model.screen.texts, [
            "已全部收回",
            "\(CardProofFlow.dateInTaiwan(now)) 記進了證明紀錄。",
            "你可以拿掉 Threads 個人檔案上的證明連結。",
            "完成",
        ])
        await Snapshot.save(model, as: "8-withdrawn")
        XCTAssertFalse(model.holdsPIN)
        try await press("完成", in: model)
        XCTAssertEqual(model.screen.step, 1)
    }

    // The date -------------------------------------------------------------------

    /// The phone's date is not the server's: the challenge is dated
    /// another day, and the card proof stops before the third tap. The
    /// card is not asked to sign what no record can be made of.
    func testAChallengeOfAnotherDateStopsBeforeTheThirdTap() async throws {
        try await onTheSecondDay()
        now = now.addingTimeInterval(24 * 3600)
        let model = makeModel()
        try await toAccounts(model)
        try await typeBob(in: model)
        XCTAssertEqual(model.screen.step, 5)
        let button = try XCTUnwrap(model.screen.buttons.last?.label)
        try await press(button, in: model)
        XCTAssertEqual(model.screen.texts, [
            "進行中",
            "請不要關閉 app，也不要切到別的 app。",
            "連上島民證明的伺服器", "停在這裡",
            "這支手機的日期和伺服器不一致，請檢查手機的時間。",
            "感應卡片，卡片簽章",
            "正在這支手機計算，產生零知識證明，大約 5 秒",
            "送出",
            "再感應一次卡片",
        ])
        XCTAssertEqual(card.taps, [.readCertificates, .sign], "no third tap")
        XCTAssertFalse(model.holdsPIN)
    }

    // The PIN ---------------------------------------------------------------------

    /// "取消" on the list drops the PIN and goes back to step 1; no record is made.
    func testCancellingDropsThePIN() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await toAccounts(model)
        XCTAssertTrue(model.holdsPIN)
        try await press("取消", in: model)
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertFalse(model.holdsPIN)
        XCTAssertEqual(card.signatures, 1, "the card signed the scope string only")
    }

    /// "感應卡片" was pressed and no card came: the demonstration of where the card goes is at rest with the card
    /// in place, and does not play again by itself, also not after "再感應一次"; its button plays it again.
    func testTheDemonstrationDoesNotPlayAgainByItselfOnceTheCardWasTapped() async throws {
        let model = makeModel(card: NoCardReader())
        try await press("下一步", in: model)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.playing, true, "it plays as the step comes up")
        try await press("感應卡片", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertTrue(model.screen.texts.contains("沒有感應到卡片。請再感應一次，把卡片平貼在手機背面的上方。"))
        XCTAssertEqual(senseDemonstration(on: model.screen)?.playing, false)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.played, true)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.control, Button(label: "再看一次", action: .playDemo))
        try await press("再感應一次", in: model)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.playing, false)
        try await press("再看一次", in: model)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.playing, true)
        // Back to step 1 and to step 2 again: it plays as the step comes up.
        try await press("再感應一次", in: model)
        model.perform(.restart)
        try await press("下一步", in: model)
        XCTAssertEqual(senseDemonstration(on: model.screen)?.playing, true)
    }

    // Five minutes with the PIN in memory (#133) ---------------------------------------------------

    /// The PIN stays in memory while the cardholder is away in another app, and five minutes after it was
    /// typed it is dropped with the card proof: step 1 says why, until the card proof starts again.
    func testThePINIsDroppedFiveMinutesAfterItWasTyped() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await toAccounts(model)
        XCTAssertTrue(model.holdsPIN)
        // To another app and back within the five minutes: the PIN and the step are still there.
        now = now.addingTimeInterval(4 * 60 + 59)
        model.cameBack()
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertTrue(model.holdsPIN)
        // Past them.
        now = now.addingTimeInterval(2)
        model.cameBack()
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertFalse(model.holdsPIN)
        XCTAssertEqual(model.screen.warnings, [Notice(text: "超過 5 分鐘沒有完成，為了不讓 PIN 留在手機上太久，已經回到開頭。請再感應一次卡片。", button: nil)])
        checkAgainstTheCopy(model.screen, file: #filePath, line: #line)
        XCTAssertEqual(card.signatures, 1, "the card signed the scope string only")
        // Starting again: step 1's note is gone, and the card is read again.
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 2)
        try await press("上一步", in: model)
        XCTAssertEqual(model.screen.warnings, [])
    }

    /// The five minutes are over while the cardholder looks at step 5: whatever is pressed, the card is not
    /// asked to sign, and the card proof is back at its start.
    func testAfterFiveMinutesTheCardDoesNotSignTheDeclaration() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await toAccounts(model)
        try await typeBob(in: model)
        XCTAssertEqual(model.screen.step, 5)
        now = now.addingTimeInterval(5 * 60)
        let button = try XCTUnwrap(model.screen.buttons.last)
        model.perform(button.action)
        while let work = model.work { await work.value }
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertTrue(model.screen.texts.contains("超過 5 分鐘沒有完成，為了不讓 PIN 留在手機上太久，已經回到開頭。請再感應一次卡片。"))
        XCTAssertEqual(card.taps, [.readCertificates, .sign], "no third tap")
        XCTAssertFalse(model.holdsPIN)
    }

    /// The PIN is gone with the last tap: five minutes after it was typed nothing is dropped, and a record
    /// that could not be sent is still there to send again.
    func testNothingHappensFiveMinutesAfterTheLastTap() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await toAccounts(model)
        try await typeBob(in: model)
        asked.submitFails = true
        let button = try XCTUnwrap(model.screen.buttons.last?.label)
        try await press(button, in: model)
        XCTAssertEqual(model.screen.step, 5)
        XCTAssertTrue(model.screen.buttons.map(\.label).contains("再試一次"))
        XCTAssertFalse(model.holdsPIN, "the PIN went with the third tap")
        now = now.addingTimeInterval(6 * 60)
        model.cameBack()
        XCTAssertEqual(model.screen.step, 5)
        XCTAssertTrue(model.screen.buttons.map(\.label).contains("再試一次"))
        XCTAssertEqual(model.screen.warnings, [])
    }

    /// A wrong PIN is dropped, and its five minutes with it: the PIN typed after it has its own.
    func testAPINThatWasDroppedDoesNotCountAgainstTheNext() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        model.pinText = "000000"
        try await press("確認卡片", in: model)
        XCTAssertTrue(model.screen.texts.contains("PIN 不正確。連續輸入錯誤三次，卡片會被鎖住。"))
        // More than five minutes later the cardholder types the right one.
        now = now.addingTimeInterval(6 * 60)
        model.cameBack()
        XCTAssertEqual(model.screen.step, 3, "no PIN was in memory: nothing to drop")
        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 4)
        // And that one has five minutes from when it was typed.
        now = now.addingTimeInterval(5 * 60)
        model.cameBack()
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertFalse(model.holdsPIN)
    }

    /// A PIN typed and left in the field is in memory too: five minutes later it is gone, with the card proof.
    func testAPINLeftInTheFieldIsDroppedAfterFiveMinutes() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        model.pinText = backend.pin
        now = now.addingTimeInterval(5 * 60)
        model.cameBack()
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertEqual(model.pinText, "")
        XCTAssertFalse(model.holdsPIN)
        XCTAssertEqual(card.pinsReceived, 0)
        // The phone's clock set back to before the PIN was typed gives it no more time.
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        model.pinText = backend.pin
        now = now.addingTimeInterval(-3600)
        model.cameBack()
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertFalse(model.holdsPIN)
        now = now.addingTimeInterval(3600)
    }

    /// The card accepted the PIN and then left; in the tap made again it leaves while the PIN goes to it. The
    /// PIN is the card's: it is not dropped, and the tap is made again (#133).
    func testAPINTheCardAcceptedIsSentAgainWhereverTheNextTapLosesTheCard() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        card.nextTapsFail = [.dropped(.accepted), .dropped(.sent)]
        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.buttons.map(\.label), ["再感應一次"])
        try await press("再感應一次", in: model)
        XCTAssertTrue(model.screen.texts.contains("卡片在感應途中離開了手機。PIN 還在，不用再輸入，請再感應一次。"))
        XCTAssertEqual(model.screen.buttons.map(\.label), ["再感應一次"])
        XCTAssertTrue(model.holdsPIN)
        try await press("再感應一次", in: model)
        XCTAssertEqual(model.screen.step, 4)
        // Each a card that left during tap 2, counted as such: the PIN had been accepted when the second left as it went.
        let dropped = countsSent.filter { $0["event"] == "action" && $0["action"] == "tap_dropped" }
        XCTAssertEqual(dropped.map { $0["tap"] }, ["2", "2"])
        XCTAssertFalse(countsSent.contains { $0["reason"] == "pin_maybe_received" })
    }

    // The server does not answer --------------------------------------------------------------------

    /// The server does not answer when asked for its config: step 2 stops at its first item, before any card
    /// is read, and the card is read again once it answers.
    func testAServerThatDoesNotAnswerStopsBeforeTheFirstTap() async throws {
        try await onTheSecondDay()
        let model = makeModel(opened: false)
        asked.configFails = true
        values["network"] = "`X`"
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertEqual(Array(model.screen.texts.dropFirst(4).prefix(3)), ["連上島民證明的伺服器", "停在這裡", "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 network）"])
        XCTAssertEqual(card.taps, [])
        asked.configFails = false
        try await press("再感應一次卡片", in: model)
        try await press("感應卡片", in: model)
        XCTAssertEqual(model.screen.buttons.map(\.label), ["下一步"])
    }

    /// From the day, the screen in the place of step 1 is drawn again when the config says otherwise: back in
    /// the app after the server's lowest version was put back, step 1 is there again.
    func testTheScreenOfAnOlderBuildGoesWhenTheConfigSaysOtherwise() async throws {
        try await onTheSecondDay()
        minApp = .stop("2027-03-01")
        let model = makeModel()
        while model.screen.step != 0 { await Task.yield() }
        minApp = .ok
        model.cameBack()
        while model.screen.step != 1 { await Task.yield() }
        XCTAssertEqual(model.screen.buttons.map(\.label), ["下一步"])
    }

    // The lowest version, a phone without NFC (ADR-0035) ---------------------------------------------

    /// A build older than the server's lowest, before the day it starts on: said above step 1, with the way
    /// to the store, and a card proof goes on as usual.
    func testBeforeTheDayAnOlderBuildSaysSoAndGoesOn() async throws {
        try await onTheSecondDay()
        let store = URL(string: "https://apps.apple.com/app/id0000000000")!
        let model = makeModel(minApp: .okUntil("2027-03-01"), storePage: store)
        while model.screen.warnings.isEmpty { await Task.yield() }
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertEqual(model.screen.warnings, [Notice(
            text: "這一版的 app 從 2027-03-01 起不能過卡。請在那之前到 App Store 更新。",
            button: Button(label: "到 App Store 更新", action: .openStore))])
        checkAgainstTheCopy(model.screen, file: #filePath, line: #line)
        model.perform(.openStore)
        XCTAssertEqual(opened.last, store)
        // Above the reminder's note too.
        model.openedFromReminder()
        while model.screen.warnings.isEmpty { await Task.yield() }
        XCTAssertNotNil(model.screen.notice)
        XCTAssertEqual(Array(model.screen.texts.prefix(3)), ["這一版的 app 從 2027-03-01 起不能過卡。請在那之前到 App Store 更新。", "到 App Store 更新", "這是過卡的提醒。現在不方便的話，可以晚點再做。"])
        try await toAccounts(model)
    }

    /// From that day on: the screen in the place of step 1, with nothing that leads to a card or a PIN.
    func testFromTheDayAnOlderBuildDoesNotReachTheCard() async throws {
        try await onTheSecondDay()
        let store = URL(string: "https://apps.apple.com/app/id0000000000")!
        let model = makeModel(minApp: .stop("2027-03-01"), storePage: store)
        while model.screen.step != 0 { await Task.yield() }
        XCTAssertEqual(model.screen.texts, [
            "這一版不能過卡了",
            "從 2027-03-01 起，這一版的島民證明 app 不能過卡。請更新到最新的版本。",
            "卡片還沒有被讀取，沒有任何東西送出去。",
            "到 App Store 更新",
            "也可以用電腦和讀卡機，在 \(try XCTUnwrap(backend.origin.host)) 過卡。",
        ])
        checkAgainstTheCopy(model.screen, file: #filePath, line: #line)
        XCTAssertEqual(model.screen.buttons, [])
        XCTAssertEqual(model.screen.settings?.label, "設定")
        // Pressed all the same, as no screen lets: nothing starts.
        model.perform(.start)
        model.perform(.readCard)
        while let work = model.work { await work.value }
        XCTAssertEqual(model.screen.step, 0)
        XCTAssertEqual(card.taps, [])
        try await press("到 App Store 更新", in: model)
        XCTAssertEqual(opened.last, store)
    }

    /// The config said the build was new enough when the app opened, and says it must stop by the time the
    /// card would be read: the card is not read.
    func testAnOlderBuildStopsBeforeTheFirstTapWhenTheConfigSaysSoThen() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        minApp = .stop("2027-03-01")
        model.perform(.readCard)
        while let work = model.work { await work.value }
        XCTAssertEqual(model.screen.step, 0)
        XCTAssertTrue(model.screen.texts.contains("這一版不能過卡了"))
        XCTAssertEqual(card.taps, [])
        // A build with no page in the store yet: the sentences without the button.
        XCTAssertFalse(model.screen.texts.contains("到 App Store 更新"))
    }

    /// A lowest version the app cannot read: the card proof does not go on, as with a config it cannot read.
    func testALowestVersionThatCannotBeReadStopsBeforeTheFirstTap() async throws {
        try await onTheSecondDay()
        let model = makeModel(minApp: .unreadable)
        // The document writes the code as `X`.
        values["malformed_response"] = "`X`"
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertTrue(model.screen.texts.contains("伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 malformed_response）"))
        XCTAssertEqual(card.taps, [])
    }

    /// A phone that cannot read a card: the screen in the place of step 1, and nothing leads to a tap.
    func testAPhoneThatCannotReadACardSaysSoInThePlaceOfStepOne() async throws {
        let model = makeModel(canReadCards: false)
        XCTAssertEqual(model.screen.step, 0)
        XCTAssertEqual(model.screen.texts, [
            "這支手機不能感應卡片",
            "這支手機沒有 NFC，不能用 app 過卡。",
            "可以用電腦和讀卡機，在 \(try XCTUnwrap(backend.origin.host)) 過卡。",
        ])
        checkAgainstTheCopy(model.screen, file: #filePath, line: #line)
        XCTAssertEqual(model.screen.buttons, [])
        model.perform(.start)
        XCTAssertEqual(model.screen.step, 0)
        XCTAssertEqual(card.taps, [])
    }

    // The card leaves, the panel is closed (#172) -------------------------------------------------

    /// The first tap: a card that left, or none that came, is tapped again; a panel the cardholder closed
    /// leaves the step as it was before the button, with no reason written.
    func testTheFirstTapIsMadeAgain() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        card.nextTapsFail = [.dropped(.notSent), .noTap, .cancelled]
        try await press("感應卡片", in: model)
        XCTAssertTrue(model.screen.texts.contains("卡片在讀取途中離開了手機。請再感應一次，感應時不要移動卡片。"))
        XCTAssertEqual(model.screen.buttons.map(\.label), ["再感應一次"])
        try await press("再感應一次", in: model)
        XCTAssertTrue(model.screen.texts.contains("沒有感應到卡片。請再感應一次，把卡片平貼在手機背面的上方。"))
        try await press("再感應一次", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertFalse(model.screen.texts.contains("停在這裡"), "no reason for a panel that was closed")
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "感應卡片"])
        try await press("感應卡片", in: model)
        XCTAssertEqual(model.screen.buttons.map(\.label), ["下一步"])
        XCTAssertEqual(card.pinsReceived, 0)
    }

    /// The second tap, with the PIN in memory: only that tap is made again, and the PIN is not typed again,
    /// when the card left before the PIN went to it, when it left after it had accepted the PIN, and when no
    /// card came. A panel the cardholder closed leaves the step as before the button, the PIN still there.
    func testTheSecondTapIsMadeAgainWithThePINInMemory() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        let kept = "卡片在感應途中離開了手機。PIN 還在，不用再輸入，請再感應一次。"
        for (failure, sentence) in [(CardFailure.dropped(.notSent), kept), (.dropped(.accepted), kept), (.noTap, "沒有感應到卡片。請再感應一次，把卡片平貼在手機背面的上方。")] {
            card.nextTapsFail = [failure]
            if model.pinText.isEmpty, !model.holdsPIN { model.pinText = backend.pin }
            let button = try XCTUnwrap(model.screen.buttons.last?.label)
            try await press(button, in: model)
            XCTAssertEqual(model.screen.step, 3)
            XCTAssertTrue(model.screen.texts.contains(sentence), "\(failure): \(model.screen.texts)")
            XCTAssertEqual(model.screen.buttons.map(\.label), ["再感應一次"])
            XCTAssertTrue(model.holdsPIN, "the PIN is kept for the tap to be made again")
            XCTAssertEqual(model.pinText, "", "and not in the field")
        }
        // The panel closed: no reason, the screen as before the button; "確認卡片" taps again with the PIN kept.
        card.nextTapsFail = [.cancelled]
        try await press("再感應一次", in: model)
        XCTAssertEqual(model.screen.step, 3)
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "確認卡片"])
        XCTAssertFalse(model.screen.blocks.contains { if case .message = $0 { return true } else { return false } }, "no reason")
        XCTAssertTrue(model.holdsPIN)
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 4, "the same tap again, with the PIN that was in memory")
        XCTAssertEqual(card.pinsReceived, 1, "the PIN went to the card once")
    }

    /// The card left while the PIN was going to it, and has never accepted this PIN: whether it counted a try
    /// is not known. The PIN is not sent again by itself: it is dropped, the screen says so, and it is typed again.
    func testAPINThatMayHaveReachedTheCardIsNotSentAgainByItself() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        card.nextTapsFail = [.dropped(.sent)]
        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 3)
        XCTAssertTrue(model.screen.texts.contains("感應在送出 PIN 的時候中斷了，不確定卡片有沒有收到。為了不在你不知道的時候多用掉一次 PIN 的錯誤次數，app 不會自動重送。請再輸入一次 PIN，再感應一次。"))
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "確認卡片"])
        XCTAssertFalse(model.holdsPIN, "the PIN is dropped")
        // Without a PIN typed again, no tap.
        let taps = card.taps.count
        try await press("確認卡片", in: model)
        XCTAssertTrue(model.screen.texts.contains("請輸入 PIN。"))
        XCTAssertEqual(card.taps.count, taps)
        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 4)
    }

    /// The third tap: the card has accepted the PIN before, so wherever this tap loses the card, also while
    /// the PIN goes to it, only this tap is made again with the PIN in memory. A panel the cardholder closed
    /// says that the card did not sign. "取消" drops the PIN.
    func testTheThirdTapIsMadeAgainWithThePINInMemory() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await toAccounts(model)
        try await typeBob(in: model)
        let signatures = card.signatures
        let left = "卡片在感應途中離開了手機。請再感應一次。"
        var button = try XCTUnwrap(model.screen.buttons.last?.label)
        for (failure, sentence) in [(CardFailure.dropped(.notSent), left), (.dropped(.sent), left), (.dropped(.accepted), left), (.cancelled, "感應取消了，卡片沒有簽。"), (.noTap, "沒有感應到卡片。請再感應一次，把卡片平貼在手機背面的上方。")] {
            card.nextTapsFail = [failure]
            try await press(button, in: model)
            XCTAssertEqual(model.screen.step, 5)
            XCTAssertTrue(model.screen.texts.contains(sentence), "\(failure): \(model.screen.texts)")
            XCTAssertEqual(model.screen.buttons.map(\.label), ["再感應一次"])
            XCTAssertEqual(model.screen.cancel?.label, "取消")
            XCTAssertTrue(model.holdsPIN, "the PIN is kept: \(failure)")
            XCTAssertEqual(card.signatures, signatures, "the card did not sign")
            button = "再感應一次"
        }
        try await press("取消", in: model)
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertFalse(model.holdsPIN)
    }

    /// A PIN the card refuses is dropped, and asked for again on the same screen.
    func testAWrongPINIsDroppedAndAskedForAgain() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        model.pinText = "000000"
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 3)
        XCTAssertTrue(model.screen.texts.contains("PIN 不正確。連續輸入錯誤三次，卡片會被鎖住。"))
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "確認卡片"])
        XCTAssertFalse(model.holdsPIN)
        XCTAssertEqual(card.signatures, 0)

        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 4)
    }

    /// No secure channel with the card at tap 2: the PIN was not sent, but
    /// it is dropped all the same and typed again; no "再感應一次卡片".
    func testNoChannelAtTheSecondTapDropsThePIN() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        card.nextSignFails = .channel
        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 3)
        XCTAssertTrue(model.screen.texts.contains("卡片和這支手機建立不起加密的連線，PIN 沒有送出。請改用電腦和讀卡機過卡。"))
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "確認卡片"])
        XCTAssertFalse(model.holdsPIN)
        XCTAssertEqual(card.pinsReceived, 0)

        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 4)
    }

    /// No secure channel with the card at tap 3: the PIN is dropped, and
    /// the only way on is back to the start.
    func testNoChannelAtTheThirdTapDropsThePIN() async throws {
        try await onTheSecondDay()
        let model = makeModel()
        try await toAccounts(model)
        try await typeBob(in: model)
        card.nextSignFails = .channel
        let button = try XCTUnwrap(model.screen.buttons.last?.label)
        try await press(button, in: model)
        XCTAssertEqual(model.screen.step, 5)
        XCTAssertTrue(model.screen.texts.contains("卡片和這支手機建立不起加密的連線，PIN 沒有送出。請改用電腦和讀卡機過卡。"))
        XCTAssertEqual(model.screen.buttons.map(\.label), ["回到開頭"])
        XCTAssertNil(model.screen.cancel)
        XCTAssertFalse(model.holdsPIN)
        XCTAssertEqual(card.signatures, 1, "the card signed the scope string only")
        try await press("回到開頭", in: model)
        XCTAssertEqual(model.screen.step, 1)
    }

    // ---------------------------------------------------------------------------

    /// The day after the back end started: the last day the test of the
    /// four kinds uses, so that these tests, which make no record, can run
    /// before it or after it.
    private func onTheSecondDay() async throws {
        now = backend.start.addingTimeInterval(24 * 3600)
        try await backend.setClock(now)
    }

    /// A model as the app makes its own, with the card and the back end of
    /// this test. `opened`: it has asked for `config`, as the screen makes
    /// it do when it is first drawn.
    private func makeModel(opened: Bool = true, card: Card? = nil, canReadCards: Bool = true, minApp: MinApp = .ok, storePage: URL? = nil) -> CardProofModel {
        let backend = self.backend!
        let asked = CountingBackend(HTTPBackend(site: backend.origin, publicFiles: backend.origin))
        if let before = self.asked { submitted += before.submitted }
        self.asked = asked
        notifier = FakeNotifier()
        reminderStore = MemoryReminderStore()
        reminders = Reminders(store: reminderStore, notifier: notifier, clock: { [unowned self] in self.now })
        let flow = CardProofFlow.Dependencies(
            proofLog: .test,
            backend: asked,
            card: card ?? self.card,
            clock: { [unowned self] in self.now },
            crlNumbers: MemoryCRLNumbers(),
            openSession: backend.openSession,
            proofFiles: BundledFile.proofFiles(for:),
            counts: Counts(Counts.Dependencies(
                send: { [unowned self] body in
                    if let count = (try? JSONSerialization.jsonObject(with: body)) as? [String: String] { self.countsSent.append(count) }
                    // On to the Worker, which takes it as from the app.
                    Task { await asked.count(body) }
                },
                clock: { [unowned self] in self.now },
                random: { Data((0..<$0).map { _ in UInt8.random(in: 0...255) }) },
                stored: { [unowned self] in self.deviceIDStored },
                store: { [unowned self] in self.deviceIDStored = $0 },
                osVersion: UIDevice.current.systemVersion,
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                model: Counts.machine())))
        let model = CardProofModel(CardProofModel.Dependencies(
            flow: flow,
            copy: Copy.bundled(),
            appCopy: Copy.bundled("app"),
            reminders: reminders,
            openSchedule: {},
            openNotificationSettings: { [unowned self] in self.notificationSettingsOpened += 1 },
            openSettings: {},
            site: backend.origin,
            open: { [unowned self] in self.opened.append($0) },
            copyText: { [unowned self] in self.copied.append($0) },
            share: { [unowned self] in self.shared.append($0) },
            canReadCards: { canReadCards },
            minApp: { [unowned self] _, _ in self.minApp ?? minApp },
            storePage: storePage))
        if opened { model.open() }
        return model
    }

    /// Steps 1 to 3: to the card's list.
    private func toAccounts(_ model: CardProofModel) async throws {
        try await press("下一步", in: model)
        try await press("感應卡片", in: model)
        try await press("下一步", in: model)
        model.pinText = backend.pin
        try await press("確認卡片", in: model)
        XCTAssertEqual(model.screen.step, 4)
    }

    /// From step 4 to step 5 with @bob, an account of the document's
    /// examples, whatever this card declares: in the field of a card that
    /// declares nothing, or after "改成別的帳號" of one that declares an account.
    private func typeBob(in model: CardProofModel) async throws {
        if model.screen.texts.contains("改成別的帳號") { try await press("改成別的帳號", in: model) }
        model.type("bob", on: "threads")
        try await press("下一步", in: model)
    }

    /// Presses the button with these words on the screen, waits for what
    /// it starts to end, and checks the screen it leaves against the copy.
    private func press(_ label: String, in model: CardProofModel, file: StaticString = #filePath, line: UInt = #line) async throws {
        func within(_ block: Block) -> [Button] {
            switch block {
            case .button(let button, _), .linked(_, let button, _), .action(let button): return [button]
            case .sideBySide(let buttons): return buttons
            case .demo(let demo): return [demo.control]
            case .senseDemo(let demo): return [demo.control]
            case .account(let row): return row.preview.map { [$0] } ?? []
            // Under a question: what its answer holds, once it is opened.
            case .question(_, let answer): return answer.flatMap(within)
            default: return []
            }
        }
        let inline = model.screen.blocks.flatMap(within)
        let buttons = model.screen.buttons + model.screen.links + (model.screen.cancel.map { [$0] } ?? []) + inline
        let button = try XCTUnwrap(buttons.first { $0.label == label }, "no button \(label) among \(buttons.map(\.label))", file: file, line: line)
        XCTAssertTrue(button.enabled, "\(label) cannot be pressed", file: file, line: line)
        model.perform(button.action)
        while let work = model.work { await work.value }
        checkAgainstTheCopy(model.screen, file: file, line: line)
    }

    /// Every sentence on the screen is one of design/copy/card-proof.md.
    private func checkAgainstTheCopy(_ screen: Screen, file: StaticString, line: UInt) {
        document.check(screen, values: values, file: file, line: line)
    }

    /// The short ID the confirm screen shows.
    private func shortID(on screen: Screen) throws -> String {
        let pairs = screen.blocks.compactMap { block -> String? in
            if case .pair("島民編號", let value) = block { return value }
            return nil
        }
        let value = try XCTUnwrap(pairs.first)
        XCTAssertTrue(value.hasSuffix(" 開頭"))
        let id = String(value.dropLast(" 開頭".count))
        XCTAssertEqual(id.count, 10)
        return id
    }

    /// The rows the screen only shows: platform, account, and the lines under it.
    private func rows(on screen: Screen) -> [[String]] {
        screen.blocks.compactMap { block in
            if case .row(let name, let account, let lines) = block { return [name, account] + lines }
            return nil
        }
    }

    private func title(of screen: Screen) -> String? {
        for case .title(let title) in screen.blocks { return title }
        return nil
    }

    /// The demonstration of step 2.
    private func senseDemonstration(on screen: Screen) -> SenseDemo? {
        for case .senseDemo(let demo) in screen.blocks { return demo }
        return nil
    }

    /// The demonstration of step 6.
    private func demonstration(on screen: Screen) -> HangDemo? {
        for case .demo(let demo) in screen.blocks { return demo }
        return nil
    }

    /// The small card of the last step.
    private func proofCard(on screen: Screen) -> ProofCard? {
        for case .proofCard(let card) in screen.blocks { return card }
        return nil
    }

    /// The short ID in the link step 6 shows.
    private func shortIDInTheLink(on screen: Screen) -> String? {
        for case .link(let link) in screen.blocks { return link.components(separatedBy: "/p/").last }
        return nil
    }

    /// What the field of Threads holds.
    private func typed(in model: CardProofModel) -> String? {
        for case .account(let row) in model.screen.blocks where row.platform == "threads" { return row.text }
        return nil
    }

    // Too many people (#420) -----------------------------------------------------------

    /// What a screen says under the item it stopped at, the request ID of this run standing where the copy has its example.
    private func checkWithTheRequestID(_ model: CardProofModel) {
        values["0123456789abcdef"] = "3f9c2a7e5b1d4c80"
        checkAgainstTheCopy(model.screen, file: #filePath, line: #line)
        values["0123456789abcdef"] = nil
    }

    /// Steps 1 to 3 with the server turning requests away as too many
    /// (docs/api/card-proof.md, "Rules for every endpoint"; ADR-0026): the
    /// config step 1 asks as the app comes back changes nothing; the start
    /// (`config?start`) turned away keeps step 1, which says so above
    /// 下一步, and no card is tapped; the config the reading asks again
    /// turned away, the card proof goes on with the start's; the card's
    /// state turned away, 再試一次 asks again without a tap.
    private func tooManyToTheList(_ model: CardProofModel) async throws {
        let say = Copy.bundled()
        // The config of step 1 as the app comes back.
        for _ in 0..<500 where asked.asked["config", default: 0] < 2 {
            asked.turnAway["config"] = [CountingBackend.rateLimited]
            model.cameBack()
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        for _ in 0..<500 where asked.turnAway["config"] != [] { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(asked.turnAway["config"], [], "step 1 asked config as the app came back, and it was turned away")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(model.screen.buttons.map(\.label), ["下一步"])
        XCTAssertFalse(model.screen.texts.contains(say("before.busy")) || model.screen.texts.contains(say("before.paused")), "step 1's config turned away: step 1 as it was")

        // The start turned away: busy, then rate limited.
        for failure in [CountingBackend.busy, CountingBackend.rateLimited] {
            asked.turnAway["config?start"] = [failure]
            let (starts, taps) = (asked.startRequests, card.taps.count)
            try await press("下一步", in: model)
            XCTAssertEqual(model.screen.step, 1, failure.code)
            XCTAssertEqual(Array(model.screen.texts.suffix(2)), [say("before.busy"), "下一步"], "\(failure.code): the sentence right above 下一步")
            XCTAssertEqual(asked.startRequests, starts + 1, "\(failure.code): 下一步 asked config with the mark, once")
            XCTAssertEqual(card.taps.count, taps, "\(failure.code): no card tapped")
            if failure == CountingBackend.busy { await Snapshot.save(model, as: "1-busy") }
        }

        // The start goes through; the config the reading asks again (asked as step 2 comes up, and once more if that one
        // has failed by the tap) is turned away, and the card is read all the same, with the start's.
        asked.turnAway["config"] = [CountingBackend.rateLimited, CountingBackend.rateLimited]
        let plain = asked.asked["config", default: 0]
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertFalse(model.screen.texts.contains(say("before.busy")))
        try await press("感應卡片", in: model)
        let turned = 2 - (asked.turnAway["config"]?.count ?? 0)
        XCTAssertEqual(asked.asked["config", default: 0] - plain, turned, "every config the reading asked was turned away (\(turned))")
        XCTAssertGreaterThan(turned, 0)
        asked.turnAway["config"] = []
        XCTAssertEqual(model.screen.buttons.map(\.label), ["下一步"], "the card was read with the start's config")
        try await press("下一步", in: model)

        // The card's state turned away: the card signed, and 再試一次 asks again.
        asked.turnAway["card-state"] = [CountingBackend.busy]
        model.pinText = backend.pin
        model.perform(.confirmCard)
        while let work = model.work { await work.value }
        checkWithTheRequestID(model)
        XCTAssertEqual(model.screen.step, 3)
        XCTAssertTrue(model.screen.texts.contains(say("stops.too_many")), "step 3: \(model.screen.texts)")
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "再試一次"])
        XCTAssertTrue(model.holdsPIN, "the PIN is kept for the last tap")
        await Snapshot.save(model, as: "3-busy")
        let (taps, pins, states) = (card.taps.count, card.pinsReceived, asked.asked["card-state", default: 0])
        // Typed into the field meanwhile: the field has no say in it, and what was typed is not kept.
        model.pinText = "000000"
        try await press("再試一次", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertEqual(model.pinText, "", "a PIN typed after the card signed is not kept")
        XCTAssertEqual(card.taps.count, taps, "再試一次: no tap")
        XCTAssertEqual(card.pinsReceived, pins, "再試一次: no PIN to the card")
        XCTAssertEqual(asked.asked["card-state"], states + 1)
    }

    /// Step 5's `button` pressed, with the challenge and then the record
    /// turned away as too many: each stops at its item with 再試一次 and
    /// 取消; 再試一次 asks for the challenge again, then the card signs once;
    /// the record is sent again, the card not tapped again.
    private func tooManyAtStepFive(_ model: CardProofModel, button: String) async throws {
        let say = Copy.bundled()
        func stoppedAt(_ item: String, _ context: String) {
            checkWithTheRequestID(model)
            let texts = model.screen.texts
            XCTAssertEqual(model.screen.step, 5, context)
            let halted = texts.firstIndex(of: say("common.halted"))
            XCTAssertEqual(halted.map { texts[$0 - 1] }, item, "\(context): stopped at \(item)")
            XCTAssertEqual(halted.map { texts[$0 + 1] }, say("stops.too_many"), context)
            XCTAssertEqual(model.screen.buttons.map(\.label), ["再試一次"], context)
            XCTAssertEqual(model.screen.cancel?.label, "取消", context)
        }
        asked.turnAway["challenges"] = [CountingBackend.rateLimited]
        asked.turnAway["records"] = [CountingBackend.busy]
        let (taps, signatures) = (card.taps.count, card.signatures)
        model.perform(try XCTUnwrap(model.screen.buttons.first { $0.label == button }).action)
        while let work = model.work { await work.value }
        stoppedAt("連上島民證明的伺服器", "the challenge turned away")
        XCTAssertEqual(card.taps.count, taps, "the challenge turned away: no tap")
        XCTAssertTrue(model.holdsPIN, "the challenge turned away: the PIN is kept")
        await Snapshot.save(model, as: "5-busy")
        // 再試一次, as the screen has it.
        model.perform(try XCTUnwrap(model.screen.buttons.first).action)
        while let work = model.work { await work.value }
        stoppedAt("送出", "the record turned away")
        XCTAssertEqual(card.taps.count, taps + 1, "the card signed once")
        XCTAssertEqual(card.signatures, signatures + 1)
        XCTAssertFalse(model.screen.texts.contains(say("stops.submit_failed")))
        await Snapshot.save(model, as: "5-busy-submit")
        try await press("再試一次", in: model)
        XCTAssertEqual(card.taps.count, taps + 1, "the record sent again: no tap")
        XCTAssertEqual(asked.asked["records"], 2)
    }

    // Card proofs stopped -----------------------------------------------------------

    /// The operator stops taking card proofs, and takes them again
    /// (app-backend.ts, PUT /__app-test/paused; #394, #402): the app opened
    /// while they are stopped says so at step 1, in place of 下一步, and
    /// asks again as it comes back; stopped after step 1, `challenges`, then
    /// `records`, answer `paused`: step 5 says stops.paused, and offers only
    /// 回到開頭, after which step 1 says they are stopped. No record is made.
    private func cardProofsStopped() async throws {
        let say = Copy.bundled()
        func until(_ what: String, _ condition: () -> Bool) async throws {
            for _ in 0..<500 where !condition() { try await Task.sleep(nanoseconds: 20_000_000) }
            XCTAssertTrue(condition(), what)
        }
        func stepOneStopped(_ model: CardProofModel, _ context: String) async throws {
            try await until("\(context): step 1 says card proofs are stopped") { model.screen.texts.contains(say("before.paused")) }
            XCTAssertEqual(model.screen.step, 1, context)
            XCTAssertFalse(model.screen.buttons.map(\.label).contains("下一步"), "\(context): no 下一步")
            checkAgainstTheCopy(model.screen, file: #filePath, line: #line)
        }
        /// Presses step 5's button, which stops: the request ID of this run stands where the copy has its example.
        func declare(_ model: CardProofModel) async throws {
            let button = try XCTUnwrap(model.screen.buttons.last)
            model.perform(button.action)
            while let work = model.work { await work.value }
            let prefix = say("stops.request_id", ["request_id": ""])
            let ids = model.screen.texts.filter { $0.hasPrefix(prefix) && $0 != prefix }.map { String($0.dropFirst(prefix.count)) }
            for id in ids { values[id] = "3f9c2a7e5b1d4c80" }
            checkAgainstTheCopy(model.screen, file: #filePath, line: #line)
            for id in ids { values[id] = nil }
        }
        func stepFiveStopped(_ model: CardProofModel, at item: String, _ context: String) {
            let texts = model.screen.texts
            XCTAssertEqual(model.screen.step, 5, context)
            let halted = texts.firstIndex(of: say("common.halted"))
            XCTAssertEqual(halted.map { texts[$0 - 1] }, item, "\(context): stopped at \(item)")
            XCTAssertEqual(halted.map { texts[$0 + 1] }, say("stops.paused"), context)
            XCTAssertTrue(texts.contains { $0.hasPrefix(say("stops.request_id", ["request_id": ""])) && $0 != say("stops.request_id", ["request_id": ""]) }, "\(context): the request ID")
            XCTAssertEqual(model.screen.buttons.map(\.label), ["回到開頭"], "\(context): only 回到開頭, not 再試一次")
            XCTAssertNil(model.screen.cancel, context)
        }

        // The app opened while card proofs are stopped; taken again while it was away.
        try await backend.setPaused(true)
        let model = makeModel()
        try await stepOneStopped(model, "opened while card proofs are stopped")
        try await backend.setPaused(false)
        model.cameBack()
        try await until("card proofs taken again: 下一步") { model.screen.buttons.map(\.label) == ["下一步"] }
        XCTAssertFalse(model.screen.texts.contains(say("before.paused")))

        // Stopped after step 1: challenges answers paused. The card signs nothing more.
        try await toAccounts(model)
        try await typeBob(in: model)
        try await backend.setPaused(true)
        let signatures = card.signatures
        try await declare(model)
        stepFiveStopped(model, at: "連上島民證明的伺服器", "challenges paused")
        XCTAssertEqual(card.signatures, signatures, "challenges paused: the card was not asked to sign")
        XCTAssertFalse(model.holdsPIN)
        try await press("回到開頭", in: model)
        try await stepOneStopped(model, "challenges paused, 回到開頭")

        // Stopped once the challenge was issued: records answers paused, after the card signed and the proof was computed.
        try await backend.setPaused(false)
        model.cameBack()
        try await until("card proofs taken again: 下一步") { model.screen.buttons.map(\.label) == ["下一步"] }
        try await toAccounts(model)
        try await typeBob(in: model)
        asked.beforeSubmit = { [backend] in try await backend!.setPaused(true) }
        try await declare(model)
        asked.beforeSubmit = nil
        stepFiveStopped(model, at: "送出", "records paused")
        try await press("回到開頭", in: model)
        try await stepOneStopped(model, "records paused, 回到開頭")

        // Taken again: the first declaration goes through, with a card that has not been tapped yet.
        try await backend.setPaused(false)
        card = FakeCard(certificates: backend.certificates, privateKey: backend.privateKey, pin: backend.pin)
    }
}
