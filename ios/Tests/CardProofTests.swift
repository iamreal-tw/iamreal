import XCTest
@testable import IamrealApp

/// Card proofs from the screens, with a card made of test keys, against
/// the Worker in the local workerd (web/test/app-backend.ts): what the six
/// screens say, what goes to the card, and what the proof log then holds,
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
        try await declares()
        try await comesAgain()
        now = backend.start.addingTimeInterval(24 * 3600)
        try await backend.setClock(now)
        try await switchesWithAnotherCardInTheWay()
        try await withdraws()
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
            "非中華民國國籍者所持有的自然人憑證無法用於島民證明。",
            "為什麼一定要實體的卡片？",
            "實體卡片簽章在卡片裡完成，卡片效期約 5 ~ 8 年。",
            "行動自然人憑證簽章依賴內政部伺服器，而且每年會更換金鑰，不適合作為島民證明使用。",
            "還沒有自然人憑證，怎麼申辦？",
            "本人攜帶身分證到戶政事務所臨櫃申辦，當場拿到卡片，費用 250 元。",
            "找附近的戶政事務所",
            "內政部憑證管理中心：如何申請自然人憑證（moica.nat.gov.tw）",
            "下一步",
        ])
        // The two ways to a card: the phone's map, and MOICA's site. Nothing of the app goes with them.
        try await press("找附近的戶政事務所", in: model)
        XCTAssertEqual(opened.last?.absoluteString.removingPercentEncoding, "https://maps.apple.com/?q=戶政事務所")
        try await press("內政部憑證管理中心：如何申請自然人憑證（moica.nat.gov.tw）", in: model)
        XCTAssertEqual(opened.last?.absoluteString, "https://moica.nat.gov.tw/")
        XCTAssertEqual(model.screen.step, 1)

        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertEqual(model.screen.texts, [
            "讀取卡片",
            "按「感應卡片」，再把自然人憑證平貼在手機背面的上方，不要移動，直到畫面說可以拿開。",
            "① 翻到有相機的那面",
            "② 卡片貼住上方",
            "把手機翻到有相機的那一面，卡片貼住上方",
            "連上島民證明的伺服器",
            "感應卡片，讀取卡片上的憑證",
            "檢查憑證",
            "下載內政部的廢止清冊，確認憑證沒有被廢止",
            "上一步",
            "感應卡片",
        ])

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
            "之後拿著這張卡片和 PIN 的人，都能查詢、更新、收回或更換這張證明宣告的 Threads 帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
            "上一步",
            "宣告這個帳號",
            "取消",
        ])
        XCTAssertTrue(model.holdsPIN, "the PIN waits in memory for the third tap")
        await Snapshot.save(model, as: "5-confirm")

        try await press("宣告這個帳號", in: model)
        XCTAssertEqual(model.screen.step, 6)
        let link = "\(try XCTUnwrap(backend.origin.host))/p/\(shortID)"
        XCTAssertEqual(model.screen.texts, [
            "島民證明", "@alice", "島民編號 \(shortID) 開頭",
            "你拿到島民證明了",
            "\(today) 記進了證明紀錄。",
            "最後一步：掛到你的 Threads 個人檔案",
            "任何人都能宣告任何帳號。你把連結掛上個人檔案，別人才知道這個帳號承認這張證明。",
            link,
            "複製連結",
            "打開 @alice 的 Threads 個人檔案",
            "按「編輯個人檔案」", "按「連結」", "按「新增連結」", "在「網址」貼上剛才複製的連結，按右上角的「完成」",
            "如果你換了新的自然人憑證：新卡片的島民編號和連結都和舊的不同。請把個人檔案的連結換成這一個。",
            "掛好了嗎？打開你的島民證明看看。",
            "頁面上的個人檔案裡看得到這個連結，就成功了。",
            "還可以做的，不做也不影響這張證明",
            "讓朋友也知道", "把你的島民證明分享到 Threads。", "分享",
            // The reminder, offered: three months from today, 9:00 in the evening.
            "提醒我回來過卡",
            "越久沒過卡，說服力越低。這支手機會在 \(When(appCopy: Copy.bundled("app")).day(Day(now).adding(days: 84)))晚上 9:00 提醒你，大約三個月後。",
            "提醒由手機自己排，不經過我們的伺服器。",
            "開啟提醒", "改間隔或時刻",
            "回到開頭",
        ])
        await Snapshot.save(model, as: "6-done")

        XCTAssertEqual(asked.configRequests, 1, "the card proof used the config the app asked for when it opened")
        // The card was tapped three times and signed twice; the PIN is gone.
        XCTAssertEqual(card.taps, [.readCertificates, .sign, .sign])
        XCTAssertEqual(card.signatures, 2)
        XCTAssertFalse(model.holdsPIN)

        // The link, copied whole; the card's page, in the browser; the account on Threads; the share sheet, with the
        // sentence and the card's page.
        let address = backend.origin.appendingPathComponent("p").appendingPathComponent(shortID)
        try await press("複製連結", in: model)
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
        try await press("打開 @alice 的 Threads 個人檔案", in: model)
        XCTAssertEqual(opened.last?.absoluteString, "https://www.threads.com/@alice")
        try await press("分享", in: model)
        let words = Copy(json: try Repository.data("design/copy/card-proof.json"))
        XCTAssertEqual(shared, ["\(words("done.share_text", ["ordinal": ordinal]))\n\(address.absoluteString)"])

        // The system does not let the app notify: nothing is set, the card proof is done all the same.
        notifier.allows = false
        try await press("開啟提醒", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertEqual(Array(model.screen.texts.suffix(4)), [
            "記得每三個月回來過卡一次",
            "越久沒過卡，說服力越低。每次過卡，島民證明上的日期就會更新成今天。",
            "沒有排提醒：手機不允許這個 app 發通知。到手機的設定打開通知後，再回來開啟提醒。",
            "回到開頭",
        ])
        XCTAssertTrue(model.screen.texts.contains("@alice"))
        XCTAssertNil(reminderStore.kept)
        XCTAssertEqual(notifier.scheduled, [])

        try await press("回到開頭", in: model)
        XCTAssertEqual(model.screen.step, 1)
    }

    private func comesAgain() async throws {
        let model = makeModel()
        try await toAccounts(model)
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

        try await press("更新島民證明", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertEqual(head(of: model.screen)?.title, "島民證明已更新")
        XCTAssertEqual(head(of: model.screen)?.card?.rows, [ProofCard.Row(name: nil, account: "@alice")])
        XCTAssertFalse(model.screen.texts.contains { $0.hasPrefix("如果你換了新的自然人憑證") })
        XCTAssertFalse(model.holdsPIN)
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
        // "不改了": what the card declares again; then to the field once more.
        try await press("不改了", in: model)
        XCTAssertTrue(model.screen.texts.contains("更新島民證明"))
        try await press("改成別的帳號", in: model)

        model.type("bob", on: "threads")
        try await press("下一步", in: model)
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@bob", "更換，原本是 @alice。", "用掉一次更換，不會恢復。之後還可以更換 4 次。"]])
        // Back: the field as it was typed.
        try await press("上一步", in: model)
        XCTAssertEqual(model.screen.step, 4)
        XCTAssertEqual(typed(in: model), "bob")
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
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertEqual(head(of: model.screen)?.title, "島民證明已更新")
        XCTAssertEqual(head(of: model.screen)?.card?.rows, [ProofCard.Row(name: nil, account: "@bob")])
        XCTAssertEqual(card.signatures, 6, "two signatures for each of the three card proofs so far")
        XCTAssertFalse(model.holdsPIN)
    }

    private func withdraws() async throws {
        let model = makeModel()
        try await toAccounts(model)
        XCTAssertEqual(Array(model.screen.texts.prefix(4)), ["你的 Threads 帳號", "這張卡片目前宣告：", "@bob", "上次過卡是今天"])
        // Changed today: changing it again today is not another switch.
        try await press("改成別的帳號", in: model)
        XCTAssertTrue(model.screen.texts.contains("今天才宣告的帳號，今天改掉不另外算一次更換。"))
        try await press("不改了", in: model)
        try await press("收回對 @bob 的宣告", in: model)
        let shortID = try shortID(on: model.screen)
        XCTAssertEqual(model.screen.texts, [
            "確認",
            "按下後，證明紀錄會公開記下這張卡片不再宣告任何帳號：",
            "Threads", "@bob", "收回",
            "日期", CardProofFlow.dateInTaiwan(now),
            "島民編號", "\(shortID) 開頭",
            "歷史證明紀錄無法刪除，依然看得出這張卡片過去曾宣告過的帳號。",
            "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。",
            "之後拿著這張卡片和 PIN 的人，都能查詢或再宣告。",
            "上一步",
            "收回對 @bob 的宣告",
            "取消",
        ])
        await Snapshot.save(model, as: "5-withdraw")

        try await press("收回對 @bob 的宣告", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertEqual(model.screen.texts, [
            "已全部收回",
            "\(CardProofFlow.dateInTaiwan(now)) 記進了證明紀錄。",
            "已經收回的帳號，個人檔案上的連結可以拿掉。",
            "回到開頭",
        ])
        await Snapshot.save(model, as: "6-withdrawn")
        XCTAssertFalse(model.holdsPIN)
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
    private func makeModel(opened: Bool = true) -> CardProofModel {
        let backend = self.backend!
        let asked = CountingBackend(HTTPBackend(site: backend.origin, publicFiles: backend.origin))
        self.asked = asked
        notifier = FakeNotifier()
        reminderStore = MemoryReminderStore()
        let flow = CardProofFlow.Dependencies(
            proofLog: .test,
            backend: asked,
            card: card,
            clock: { [unowned self] in self.now },
            crlNumbers: MemoryCRLNumbers(),
            openSession: backend.openSession,
            proofFiles: BundledFile.proofFiles(for:))
        let model = CardProofModel(CardProofModel.Dependencies(
            flow: flow,
            copy: Copy.bundled(),
            appCopy: Copy.bundled("app"),
            reminders: Reminders(store: reminderStore, notifier: notifier, clock: { [unowned self] in self.now }),
            openSchedule: {},
            openSettings: {},
            site: backend.origin,
            open: { [unowned self] in self.opened.append($0) },
            copyText: { [unowned self] in self.copied.append($0) },
            share: { [unowned self] in self.shared.append($0) }))
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
            case .account(let row): return row.preview.map { [$0] } ?? []
            // Under a question: what its answer holds, once it is opened.
            case .question(_, let answer): return answer.flatMap(within)
            default: return []
            }
        }
        let inline = model.screen.blocks.flatMap(within)
        let buttons = model.screen.buttons + [model.screen.secondary, model.screen.cancel].compactMap { $0 } + inline
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

    /// The box on top of the done screen: its small card and its title.
    private func head(of screen: Screen) -> (card: ProofCard?, title: String)? {
        for case .doneHead(let card, let title, _) in screen.blocks { return (card, title) }
        return nil
    }

    /// What the field of Threads holds.
    private func typed(in model: CardProofModel) -> String? {
        for case .account(let row) in model.screen.blocks where row.platform == "threads" { return row.text }
        return nil
    }
}
