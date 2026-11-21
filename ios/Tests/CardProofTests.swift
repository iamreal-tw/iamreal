import XCTest
@testable import IamrealApp

/// Card proofs from the screens, with a card made of test keys, against
/// the Worker in the local workerd (web/test/app-backend.ts): what the six
/// screens say, what goes to the card, and what the roster then holds,
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
    /// The back end of the model made last, which counts what it is asked.
    private var asked: CountingBackend!
    private var document = ""
    /// The values of this run that stand where the document has an example.
    private var values: [String: String] = [:]

    override func setUp() async throws {
        backend = try TestBackend.load()
        card = FakeCard(certificates: backend.certificates, privateKey: backend.privateKey, pin: backend.pin)
        now = backend.start
        document = try Repository.text("design/copy/card-proof.md")
        values = ["測試用戶": "王小明", backend.origin.host ?? "": "iamreal.tw"]
    }

    // The four kinds, one card ------------------------------------------------------

    /// A first declaration, a card proof again, a switch and a withdrawal,
    /// in that order: the roster then holds `first`, `refresh`, `switch`,
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
            "請準備好你的實體自然人憑證。",
            "我們只收台灣中華民國國民的自然人憑證正卡。外來人口申辦的自然人憑證不能用。",
            "一張自然人憑證換一張島民證明，上面寫著這張卡片宣告的 Threads 帳號。",
            "為什麼一定要實體的卡片？",
            "實體卡片的簽章在卡片裡完成，只經過你的裝置。",
            "行動自然人憑證的簽章要經過內政部的伺服器，內政部查得出是誰在使用；流程還要你輸入身分證字號，我們就得經手不必要的個資。所以只收實體的卡片。",
            "還沒有自然人憑證，怎麼申辦？",
            "本人攜帶身分證到戶政事務所臨櫃申辦，當場拿到卡片，費用 250 元。",
            "內政部憑證管理中心的說明（moica.nat.gov.tw）",
            "下一步",
        ])

        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 2)
        XCTAssertEqual(model.screen.texts, [
            "讀取卡片",
            "按「感應卡片」，再把自然人憑證平貼在手機背面的上方，不要移動，直到畫面說可以拿開。這一步不用 PIN。",
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
            "卡片會簽章一次，用來查這張卡片目前宣告的帳號。這一步還不會宣告，在你確認之前，不會公開任何東西。",
            "PIN、姓名和憑證、卡片的簽章不會離開這支手機。",
            "拿到你的卡片和 PIN 的人，查得出這張卡片宣告過的帳號。卡片請自行保管、請勿出借給他人。",
            "了解更多",
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
            "Threads", "預覽", "還沒有宣告過。",
            "一張卡片只能宣告一個 Threads 帳號，之後改成別的帳號是更換。更換的次數有限，用掉就不會恢復。",
            "了解更多",
            "預覽會在 Threads 或瀏覽器開這個帳號的頁面，讓你確認沒有打錯。",
            "系統不會確認帳號是不是你的：任何持卡人都可以宣告任何帳號。",
            "帳號主人把這張島民證明的連結放在自己的個人檔案上，才表示承認。",
            "了解更多",
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
            "按下後，名冊會公開記下這張卡片宣告的帳號：",
            "Threads", "@alice", "新宣告",
            "日期", today,
            "島民編號", "\(shortID) 開頭",
            "這個 Threads 帳號會公開列在島民證明上。",
            "紀錄裡沒有姓名、身分證字號和憑證序號。平台、營運者、政府都查不出這是誰的卡片；但拿到你的卡片和 PIN 的人，查得出你宣告過的帳號。",
            "之後可以用同一張卡片收回或更換帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
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
            "你拿到島民證明了",
            "島民證明",
            "Threads", "@alice",
            "日期", today,
            "島民編號", "\(shortID) 開頭",
            "AI 辦不了自然人憑證。",
            "掛到個人檔案上，讓大家看到你是島民！",
            "接下來：把它掛出來",
            "把下面的連結放在這個 Threads 帳號的個人檔案上。別人從帳號的個人檔案點進來，才知道帳號主人承認這張島民證明。",
            link,
            "複製連結",
            "打開 Threads",
            "複製連結之後，在 Threads 打開你的個人檔案，按「編輯個人檔案」，貼在「連結」。",
            "如果你是換了新的自然人憑證：新卡片的島民編號和連結都和舊的不同。個人檔案上放的是舊連結的話，請換成這一個。",
            "打開這張島民證明",
            "名冊記下了這一筆",
            today,
            "有一張有效的自然人憑證宣告了這個帳號：",
            "Threads", "@alice", "新宣告",
            "這張卡片的島民編號開頭是 \(shortID)。",
            "越久沒過卡，說服力越低。建議每季回來過卡一次，更新這個帳號的日期。",
            "之後如果改了帳號的名稱，請回來過卡更換，這會用掉一次更換。名冊記的是名稱，舊的名稱之後可能被別人註冊。",
            "你不需要相信我們。任何人都可以驗證這筆紀錄來自一張有效的自然人憑證。",
            "怎麼驗證",
            "回到開頭",
        ])
        await Snapshot.save(model, as: "6-done")

        XCTAssertEqual(asked.configRequests, 1, "the card proof used the config the app asked for when it opened")
        // The card was tapped three times and signed twice; the PIN is gone.
        XCTAssertEqual(card.taps, [.readCertificates, .sign, .sign])
        XCTAssertEqual(card.signatures, 2)
        XCTAssertFalse(model.holdsPIN)

        // The link, copied whole; the card's page, in the browser; Threads.
        let address = backend.origin.appendingPathComponent("p").appendingPathComponent(shortID)
        try await press("複製連結", in: model)
        XCTAssertEqual(copied, [address.absoluteString])
        XCTAssertTrue(model.screen.texts.contains("已複製"))
        try await press("打開這張島民證明", in: model)
        XCTAssertEqual(opened.last, address)
        let (page, response) = try await URLSession.shared.data(from: address)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue(String(decoding: page, as: UTF8.self).contains("@alice"), "the card's page lists the account")
        try await press("打開 Threads", in: model)
        XCTAssertEqual(opened.last?.absoluteString, "https://www.threads.com/@alice")

        try await press("回到開頭", in: model)
        XCTAssertEqual(model.screen.step, 1)
    }

    private func comesAgain() async throws {
        let model = makeModel()
        try await toAccounts(model)
        XCTAssertEqual(Array(model.screen.texts.prefix(6)), [
            "你的 Threads 帳號",
            "這是這張卡片目前宣告的帳號。上次過卡是今天。",
            "Threads", "預覽",
            "還沒有更換過，還可以更換 5 次。",
            "今天才宣告的帳號，今天改掉不另外算一次更換。",
        ])
        XCTAssertEqual(typed(in: model), "alice", "the field starts with the account declared")
        XCTAssertTrue(model.screen.texts.contains("什麼都不改，直接按「下一步」，就是再次過卡：把上次過卡的日期更新成今天。"))
        XCTAssertTrue(model.screen.texts.contains("填上空白的是新宣告，清空是收回，改成別的帳號是更換。更換的次數有限，用掉就不會恢復。"))

        try await press("下一步", in: model)
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@alice", "不變"]])
        XCTAssertEqual(model.screen.buttons.map(\.label), ["上一步", "再次過卡"])

        try await press("再次過卡", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertEqual(model.screen.texts.first, "島民證明已更新")
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@alice"], ["Threads", "@alice", "不變"]])
        XCTAssertFalse(model.screen.texts.contains { $0.hasPrefix("如果你是換了新的自然人憑證") })
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
        XCTAssertEqual(Array(model.screen.texts.prefix(5)), [
            "你的 Threads 帳號",
            "這是這張卡片目前宣告的帳號。上次過卡是 1 天前。",
            "Threads", "預覽",
            "還沒有更換過，還可以更換 5 次。",
        ])

        model.type("bob", on: "threads")
        try await press("下一步", in: model)
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@bob", "更換，原本是 @alice。", "用掉一次更換，不會恢復。之後還可以更換 4 次。"]])
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
            "在這支手機上計算，大約 5 秒",
            "送出",
            "再感應一次",
            "取消",
        ])
        XCTAssertEqual(other.pinsReceived, 0, "the PIN did not go to the other card")
        await Snapshot.save(model, as: "5-other-card")

        try await press("再感應一次", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertEqual(model.screen.texts.first, "島民證明已更新")
        XCTAssertEqual(rows(on: model.screen), [["Threads", "@bob"], ["Threads", "@bob", "更換，原本是 @alice。"]])
        XCTAssertEqual(card.signatures, 6, "two signatures for each of the three card proofs so far")
        XCTAssertFalse(model.holdsPIN)
    }

    private func withdraws() async throws {
        let model = makeModel()
        try await toAccounts(model)
        XCTAssertEqual(Array(model.screen.texts.prefix(6)), [
            "你的 Threads 帳號",
            "這是這張卡片目前宣告的帳號。上次過卡是今天。",
            "Threads", "預覽",
            "更換過 1 次，還可以更換 4 次。",
            "今天才宣告的帳號，今天改掉不另外算一次更換。",
        ])
        model.type("", on: "threads")
        try await press("下一步", in: model)
        let shortID = try shortID(on: model.screen)
        XCTAssertEqual(model.screen.texts, [
            "確認",
            "按下後，名冊會公開記下這張卡片不再宣告任何帳號：",
            "Threads", "@bob", "收回",
            "日期", CardProofFlow.dateInTaiwan(now),
            "島民編號", "\(shortID) 開頭",
            "收回之後，名冊上原本的紀錄還在：看得出這張卡片宣告過這個帳號。",
            "紀錄裡沒有姓名、身分證字號和憑證序號。平台、營運者、政府都查不出這是誰的卡片；但拿到你的卡片和 PIN 的人，查得出你宣告過的帳號。",
            "之後可以用同一張卡片再宣告。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
            "上一步",
            "收回所有帳號",
            "取消",
        ])
        await Snapshot.save(model, as: "5-withdraw")

        try await press("收回所有帳號", in: model)
        XCTAssertEqual(model.screen.step, 6)
        XCTAssertEqual(model.screen.texts, [
            "已全部收回",
            "名冊記下了這一筆",
            CardProofFlow.dateInTaiwan(now),
            "有一張有效的自然人憑證收回了所有帳號的宣告：",
            "Threads", "@bob", "收回",
            "這張卡片的島民編號開頭是 \(shortID)。",
            "你不需要相信我們。任何人都可以驗證這筆紀錄來自一張有效的自然人憑證。",
            "怎麼驗證",
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
        // An account of the document's examples, whatever this card declared before.
        model.type("bob", on: "threads")
        try await press("下一步", in: model)
        XCTAssertEqual(model.screen.step, 5)
        let button = try XCTUnwrap(model.screen.buttons.last?.label)
        try await press(button, in: model)
        XCTAssertEqual(model.screen.texts, [
            "進行中",
            "請不要關閉 app，也不要切到別的 app。",
            "連上島民證明的伺服器", "停在這裡",
            "這支手機的日期和伺服器不一致，請檢查手機的時間。",
            "感應卡片，卡片簽章",
            "在這支手機上計算，大約 5 秒",
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
        let flow = CardProofFlow.Dependencies(
            roster: .test,
            backend: asked,
            card: card,
            clock: { [unowned self] in self.now },
            crlNumbers: MemoryCRLNumbers(),
            openSession: backend.openSession,
            proofFiles: BundledFile.proofFiles(for:))
        let model = CardProofModel(CardProofModel.Dependencies(
            flow: flow,
            copy: Copy.bundled(),
            site: backend.origin,
            open: { [unowned self] in self.opened.append($0) },
            copyText: { [unowned self] in self.copied.append($0) }))
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

    /// Presses the button with these words on the screen, waits for what
    /// it starts to end, and checks the screen it leaves against the copy.
    private func press(_ label: String, in model: CardProofModel, file: StaticString = #filePath, line: UInt = #line) async throws {
        let inline = model.screen.blocks.flatMap { block -> [Button] in
            switch block {
            case .button(let button): return [button]
            case .account(let row): return row.preview.map { [$0] } ?? []
            default: return []
            }
        }
        let buttons = model.screen.buttons + (model.screen.cancel.map { [$0] } ?? []) + inline
        let button = try XCTUnwrap(buttons.first { $0.label == label }, "no button \(label) among \(buttons.map(\.label))", file: file, line: line)
        XCTAssertTrue(button.enabled, "\(label) cannot be pressed", file: file, line: line)
        model.perform(button.action)
        while let work = model.work { await work.value }
        checkAgainstTheCopy(model.screen, file: file, line: line)
    }

    /// Every sentence on the screen is one of design/copy/card-proof.md:
    /// with the document's example in the place of each value of this run
    /// and any number for a number, it is in the document word for word.
    private func checkAgainstTheCopy(_ screen: Screen, file: StaticString, line: UInt) {
        for text in screen.texts where !text.isEmpty {
            var sentence = text
            for (value, example) in values where !value.isEmpty { sentence = sentence.replacingOccurrences(of: value, with: example) }
            // A date and a short ID are the document's examples.
            sentence = sentence.replacingOccurrences(of: #"\d{4}-\d{2}-\d{2}"#, with: "2026-11-16", options: .regularExpression)
            sentence = sentence.replacingOccurrences(of: #"(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{10}(?![0-9A-Za-z])"#, with: "7K2Q9FM4XD", options: .regularExpression)
            let pattern = NSRegularExpression.escapedPattern(for: sentence).replacingOccurrences(of: #"\d+"#, with: #"\\d+"#, options: .regularExpression)
            XCTAssertNotNil(document.range(of: pattern, options: .regularExpression), "not in design/copy/card-proof.md: \(text)", file: file, line: line)
        }
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

    /// What the field of Threads holds.
    private func typed(in model: CardProofModel) -> String? {
        for case .account(let row) in model.screen.blocks where row.platform == "threads" { return row.text }
        return nil
    }
}
