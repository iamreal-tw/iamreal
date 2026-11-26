import SwiftUI
import UIKit
import XCTest
@testable import IamrealApp

/// The screens of design/screens/ (card-proof-app-*, app-splash), made from
/// the examples of design/copy/card-proof.md (`@alice`, `7K2Q9FM4XD`,
/// 2026-11-16, 王小明) without a back end: every sentence on them is in the
/// document, and each is drawn as the app draws it, the whole screen 390
/// points wide, to web/test-output/app/screens-ios/ under the name of the
/// picture it stands for (ios/README.md, the screenshots).
@MainActor
final class ScreensTests: XCTestCase {
    typealias Flow = CardProofFlow

    private var copy: Copy!
    private var appCopy: Copy!
    private var screens: Screens!
    private var document: CopyDocument!

    override func setUpWithError() throws {
        copy = Copy(json: try Repository.data("design/copy/card-proof.json"))
        appCopy = Copy(json: try Repository.data("design/copy/app.json"))
        screens = Screens(copy: copy, appCopy: appCopy, host: "iamreal.tw")
        document = try CopyDocument.load()
    }

    /// The reminder's screens on 2026-11-16 (a Monday), at noon in Taiwan,
    /// with nothing kept yet: three months from it is 2027-02-08.
    private func reminderPages() -> (Reminders, ReminderPages) {
        var taipei = Calendar(identifier: .gregorian)
        taipei.timeZone = TimeZone(identifier: "Asia/Taipei")!
        let noon = taipei.date(from: DateComponents(year: 2026, month: 11, day: 16, hour: 12))!
        let reminders = Reminders(store: MemoryReminderStore(), notifier: FakeNotifier(), clock: { noon }, calendar: taipei)
        let pages = ReminderPages(ReminderPages.Dependencies(
            reminders: reminders, appCopy: appCopy, serviceName: copy("common.service_name"),
            site: URL(string: "https://iamreal.tw")!, version: "dev", open: { _ in }))
        return (reminders, pages)
    }

    private let threeMonths = ReminderSettings(interval: .weeks12, time: .evening, next: Day(2027, 2, 8))

    /// A card that has declared nothing, on the one platform the app knows.
    private let newCard = Flow.CardStatus(
        shortID: "7K2Q9FM4XD", lastCardProof: nil, daysSince: nil, dailyLimit: false, knownPlatforms: ["threads"],
        rows: [Flow.StatusRow(platform: "threads", known: true, current: nil, lastDeclared: nil, switchCount: 0, switchesLeft: 5, correctionToday: false)])

    /// A card that declares @alice, `days` days after its last card proof,
    /// with `used` of its 5 switches used.
    private func card(days: Int = 12, used: Int = 1, today: Bool = false, dailyLimit: Bool = false) -> Flow.CardStatus {
        Flow.CardStatus(
            shortID: "7K2Q9FM4XD", lastCardProof: "2026-11-04", daysSince: days, dailyLimit: dailyLimit, knownPlatforms: ["threads"],
            rows: [Flow.StatusRow(platform: "threads", known: true, current: "alice", lastDeclared: "alice", switchCount: used, switchesLeft: 5 - used, correctionToday: today)])
    }

    private func consequence(_ kind: String, _ username: String, switchesLeft: Int? = nil) -> Flow.Consequence {
        let row = Flow.ConsequenceRow(platform: "threads", known: true, kind: kind, username: username, current: "alice", previous: kind == "switch" ? "alice" : nil, switchesLeft: switchesLeft)
        return Flow.Consequence(accounts: kind == "withdraw" ? [] : [Flow.Account(platform: "threads", username: username)], rows: [row], firstRecord: false, today: "2026-11-16")
    }

    private func declaration() -> (Flow.Consequence, Flow.Done) {
        let row = Flow.ConsequenceRow(platform: "threads", known: true, kind: "first", username: "alice", current: nil, previous: nil, switchesLeft: nil)
        let accounts = [Flow.Account(platform: "threads", username: "alice")]
        let consequence = Flow.Consequence(accounts: accounts, rows: [row], firstRecord: true, today: "2026-11-16")
        let done = Flow.Done(
            date: "2026-11-16", shortID: "7K2Q9FM4XD", accounts: accounts, expected: [row],
            answer: Flow.Answer(seq: 138, recordHash: String(repeating: "3f", count: 32), ordinal: 128, kinds: [Flow.Recorded(platform: "threads", kind: "first", username: "alice", accountCards: 1)], mismatches: []),
            firstRecord: true)
        return (consequence, done)
    }

    /// The screens of a first declaration, by the name of their picture.
    private func firstDeclaration() -> [(String, Screen)] {
        let (consequence, done) = declaration()
        return [
            ("card-proof-app-1-before-phone", screens.before()),
            ("card-proof-app-2-read-iphone-phone", screens.read(reached: 0, running: false, stop: nil)),
            ("card-proof-app-3-pin-phone", screens.pin(name: "王小明", state: .waiting(nil))),
            ("card-proof-app-4-accounts-phone", screens.accounts(newCard, typed: ["threads": "alice"], errors: [:], message: nil)),
            ("card-proof-app-5-confirm-phone", screens.confirm(newCard, consequence)),
            ("card-proof-app-5-progress-phone", screens.progress(reached: 2, stop: nil)),
            ("card-proof-app-6-done-phone", screens.done(done, single: "Threads", copied: false, reminder: .ask(threeMonths))),
        ]
    }

    func testEverySentenceOfTheScreensIsInTheDocument() {
        for (_, screen) in firstDeclaration() + laterCardProofs() {
            document.check(screen)
        }
    }

    /// Step 4 and step 5 for a card that declares @alice, by the name of a picture.
    private func laterCardProofs() -> [(String, Screen)] {
        [
            ("card-proof-app-4-accounts-existing-phone", screens.accounts(card(), typed: ["threads": "alice"], errors: [:], message: nil)),
            ("card-proof-app-4-accounts-switch-phone", screens.accounts(card(), mode: .switching, typed: ["threads": "carol.tw"], errors: [:], message: nil)),
            ("card-proof-app-5-confirm-refresh-phone", screens.confirm(card(), consequence("refresh", "alice"))),
            ("card-proof-app-5-confirm-switch-phone", screens.confirm(card(), consequence("switch", "carol.tw", switchesLeft: 3))),
            ("card-proof-app-5-confirm-withdraw-phone", screens.confirm(card(), consequence("withdraw", "alice"))),
        ]
    }

    /// Step 1 as card-proof.md writes it for the app: what to prepare, the
    /// two questions, and under the second the two ways out.
    func testStepOneSaysWhatToPrepareAndWhereToGetACard() {
        let screen = screens.before()
        XCTAssertEqual(screen.texts, [
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
        guard case .question(_, let answer)? = screen.blocks.last else { return XCTFail("no question at the end: \(screen.blocks)") }
        XCTAssertEqual(Array(answer.dropFirst()), [
            .button(Button(label: "找附近的戶政事務所", action: .findOffice), main: false),
            .action(Button(label: "內政部憑證管理中心：如何申請自然人憑證（moica.nat.gov.tw）", action: .howToApply)),
        ])
        // The phone's map searches for the word; the app sends no place of its own.
        XCTAssertEqual(CardProofModel.findOffice.absoluteString.removingPercentEncoding, "https://maps.apple.com/?q=戶政事務所")
        XCTAssertEqual(CardProofModel.moica.absoluteString, "https://moica.nat.gov.tw/")
    }

    /// Step 3 says two things under the field; who holds the card and the PIN is step 5's to say.
    func testStepThreeSaysTwoThingsUnderTheField() {
        XCTAssertEqual(Array(screens.pin(name: "王小明", state: .waiting(nil)).texts.suffix(4)), [
            "按下確認後，卡片會簽章一次，用來查詢這張卡片目前宣告的帳號。",
            "PIN、姓名和憑證、卡片的簽章不會離開這支手機。",
            "上一步", "確認卡片",
        ])
    }

    // Step 4, by what the card declares ------------------------------------------

    func testStepFourOfACardThatDeclaresNothingHasOnlyTheField() {
        let screen = screens.accounts(newCard, typed: ["threads": ""], errors: [:], message: nil)
        XCTAssertEqual(screen.texts, [
            "你的 Threads 帳號",
            "這張卡片還沒有宣告過帳號。",
            "填上你要宣告的 Threads 帳號。",
            "Threads", "預覽",
            "預覽會在 Threads 或瀏覽器打開個人檔案，讓你確認沒有打錯。",
            "下一步",
            "取消",
        ])
        XCTAssertEqual(screen.buttons.map(\.action), [.toConfirm])
    }

    /// Everything was withdrawn: the field, and under it the account declared last and the switches left.
    func testStepFourOfACardThatWithdrewEverything() {
        let withdrawn = Flow.CardStatus(
            shortID: "7K2Q9FM4XD", lastCardProof: "2026-11-04", daysSince: 12, dailyLimit: false, knownPlatforms: ["threads"],
            rows: [Flow.StatusRow(platform: "threads", known: true, current: nil, lastDeclared: "bob", switchCount: 1, switchesLeft: 4, correctionToday: false)])
        let screen = screens.accounts(withdrawn, typed: ["threads": ""], errors: [:], message: nil)
        XCTAssertEqual(screen.texts, [
            "你的 Threads 帳號",
            "這張卡片目前沒有宣告任何帳號。",
            "填上你要宣告的 Threads 帳號。",
            "Threads", "預覽",
            "上一次宣告的是 @bob，已經收回。填回 @bob 不算更換。",
            "更換過 1 次，還可以更換 4 次。",
            "預覽會在 Threads 或瀏覽器打開個人檔案，讓你確認沒有打錯。",
            "下一步",
            "取消",
        ])
        document.check(screen)
    }

    func testStepFourOfACardThatDeclaresAnAccount() {
        let screen = screens.accounts(card(), typed: ["threads": "alice"], errors: [:], message: nil)
        XCTAssertEqual(screen.texts, [
            "你的 Threads 帳號",
            "這張卡片目前宣告：",
            "@alice",
            "上次過卡是 12 天前",
            "更新島民證明",
            "宣告帳號不變，把島民證明上的日期更新成今天。",
            "改成別的帳號",
            "收回對 @alice 的宣告",
            "取消",
        ])
        // One main button; the other two are links under it.
        XCTAssertEqual(Array(screen.blocks.suffix(4)), [
            .button(Button(label: "更新島民證明", action: .refresh), main: true),
            .small("宣告帳號不變，把島民證明上的日期更新成今天。"),
            .action(Button(label: "改成別的帳號", action: .toSwitch)),
            .action(Button(label: "收回對 @alice 的宣告", action: .withdraw)),
        ])
        XCTAssertEqual(screen.buttons, [])
        XCTAssertFalse(screen.blocks.contains { if case .account = $0 { return true } else { return false } }, "nothing to type")
        // The same day: "today", not "0 days ago".
        XCTAssertTrue(screens.accounts(card(days: 0), typed: [:], errors: [:], message: nil).texts.contains("上次過卡是今天"))
    }

    func testStepFourToAnotherAccount() {
        let screen = screens.accounts(card(), mode: .switching, typed: ["threads": "carol.tw"], errors: [:], message: nil)
        XCTAssertEqual(screen.texts, [
            "你的 Threads 帳號",
            "這張卡片目前宣告 @alice。",
            "改成別的帳號",
            "Threads", "預覽",
            "改了之後，@alice 不再是這張卡片宣告的帳號。", "一張卡終身最多更換 5 次，這次之後還可以更換 3 次。",
            "預覽會在 Threads 或瀏覽器打開個人檔案，讓你確認沒有打錯。",
            "下一步",
            "不改了",
            "取消",
        ])
        XCTAssertEqual(screen.secondary, Button(label: "不改了", action: .keep))
        // What it costs, by the switches left.
        func cost(_ status: Flow.CardStatus) -> String? {
            for case .sentences(let sentences) in screens.accounts(status, mode: .switching, typed: [:], errors: [:], message: nil).blocks { return sentences.last }
            return nil
        }
        XCTAssertEqual(cost(card(used: 4)), "用掉最後一次更換。這次之後，這個平台不能再更換。")
        XCTAssertEqual(cost(card(used: 5, today: true)), "今天才宣告的帳號，今天改掉不另外算一次更換。")
        // None left, and the account was not put there today: no field, and the only ways are back.
        let usedUp = screens.accounts(card(used: 5), mode: .switching, typed: [:], errors: [:], message: nil)
        XCTAssertEqual(usedUp.texts, ["你的 Threads 帳號", "這張卡片目前宣告 @alice。", "已經更換 5 次，這個平台不能再更換。", "不改了", "取消"])
        for status in [card(used: 4), card(used: 5, today: true), card(used: 5)] {
            document.check(screens.accounts(status, mode: .switching, typed: [:], errors: [:], message: nil))
        }
    }

    /// 3 records today: what the card declares, and the way back to the start; whatever the screen was.
    func testStepFourOnADayWithThreeRecords() {
        for mode in [Screens.AccountsMode.open, .switching] {
            let screen = screens.accounts(card(days: 0, dailyLimit: true), mode: mode, typed: [:], errors: [:], message: nil)
            XCTAssertEqual(screen.texts, [
                "你的 Threads 帳號",
                "這張卡片目前宣告：",
                "@alice",
                "上次過卡是今天",
                "這張卡片今天已經過卡 3 次，明天才能再過卡。",
                "回到開頭",
            ])
            XCTAssertNil(screen.cancel)
            document.check(screen)
        }
    }

    /// The card keeps an account on a platform the app does not know: the
    /// screens speak of more than one platform, and the list is changed row by row.
    func testStepFourWithAPlatformTheAppDoesNotKnow() {
        let rows = [
            Flow.StatusRow(platform: "test-example", known: false, current: "alice-b", lastDeclared: "alice-b", switchCount: 0, switchesLeft: 5, correctionToday: false),
            Flow.StatusRow(platform: "threads", known: true, current: "alice", lastDeclared: "alice", switchCount: 1, switchesLeft: 4, correctionToday: false),
        ]
        let status = Flow.CardStatus(shortID: "7K2Q9FM4XD", lastCardProof: "2026-11-04", daysSince: 12, dailyLimit: false, knownPlatforms: ["threads"], rows: rows)
        let declared = screens.accounts(status, typed: [:], errors: [:], message: nil)
        XCTAssertEqual(declared.texts, [
            "你的帳號",
            "這張卡片目前宣告：",
            "test-example", "alice-b", "這一頁還不認得這個平台。這個帳號會原樣保留，在這裡不能修改。",
            "Threads", "@alice",
            "上次過卡是 12 天前",
            "更新島民證明",
            "宣告帳號不變，把島民證明上的日期更新成今天。",
            "修改帳號清單",
            "取消",
        ])
        let editing = screens.accounts(status, mode: .editing, typed: ["threads": "alice"], errors: [:], message: nil)
        XCTAssertEqual(editing.texts, [
            "你的帳號",
            "這是這張卡片目前宣告的帳號。",
            "test-example", "alice-b", "這一頁還不認得這個平台。這個帳號會原樣保留，在這裡不能修改。",
            "Threads", "預覽", "更換過 1 次，還可以更換 4 次。",
            "填上空白的是新宣告，清空是收回，改成別的帳號是更換。一張卡終身最多只能更換宣告的帳號 5 次。",
            "預覽會在 Threads 或瀏覽器打開個人檔案，讓你確認沒有打錯。",
            "下一步",
            "不改了",
            "取消",
        ])
        document.check(declared)
        document.check(editing)
    }

    // Step 5 ---------------------------------------------------------------------

    func testStepFiveOfACardProofAgain() {
        let screen = screens.confirm(card(), consequence("refresh", "alice"))
        XCTAssertEqual(screen.texts, [
            "確認",
            "按下後，證明紀錄會記下新的證明並公開給所有人：",
            "Threads", "@alice", "不變",
            "日期", "2026-11-16",
            "島民編號", "7K2Q9FM4XD 開頭",
            "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。",
            "之後拿著這張卡片和 PIN 的人，都能查詢、更新、收回或更換這張證明宣告的 Threads 帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
            "上一步", "更新島民證明",
            "取消",
        ])
        // "所有紀錄公開後無法刪除" is the part in bold.
        guard case .points(_, let bold)? = screen.blocks.last else { return XCTFail("no points at the end: \(screen.blocks)") }
        XCTAssertEqual(bold, "所有紀錄公開後無法刪除")
    }

    func testStepFiveByWhatTheListDoes() {
        XCTAssertEqual(screens.confirm(newCard, declaration().0).buttons.last?.label, "宣告這個帳號")
        let switching = screens.confirm(card(), consequence("switch", "carol.tw", switchesLeft: 3))
        XCTAssertEqual(switching.buttons.last?.label, "宣告這個帳號")
        XCTAssertTrue(switching.texts.contains("用掉一次更換，不會恢復。之後還可以更換 3 次。"))
        XCTAssertTrue(switching.texts.contains("按下後，證明紀錄會記下新的證明並公開給所有人："))
        let withdrawing = screens.confirm(card(), consequence("withdraw", "alice"))
        XCTAssertEqual(withdrawing.texts, [
            "確認",
            "按下後，證明紀錄會公開記下這張卡片不再宣告任何帳號：",
            "Threads", "@alice", "收回",
            "日期", "2026-11-16",
            "島民編號", "7K2Q9FM4XD 開頭",
            "歷史證明紀錄無法刪除，依然看得出這張卡片過去曾宣告過的帳號。",
            "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。",
            "之後拿著這張卡片和 PIN 的人，都能查詢或再宣告。",
            "上一步", "收回對 @alice 的宣告",
            "取消",
        ])
    }

    /// The splash screen's words are design/copy/app.md's: the lines of the
    /// code block of its section, in their order.
    func testTheSplashScreenSaysWhatAppMDWrites() throws {
        let document = try Repository.text("design/copy/app.md")
        let section = try XCTUnwrap(document.components(separatedBy: "\n## 啟動畫面\n").dropFirst().first)
        let block = try XCTUnwrap(section.components(separatedBy: "```\n").dropFirst().first)
        let appCopy = Copy(json: try Repository.data("design/copy/app.json"))
        XCTAssertEqual(block.split(separator: "\n").map(String.init), [appCopy("splash.name"), appCopy("splash.site")])
    }

    /// The screen to choose the interval and time, as design/copy/app.md
    /// writes it: nothing kept, so three months, 9:00 in the evening.
    func testTheScheduleScreenSaysWhatAppMDWrites() async throws {
        let (reminders, pages) = reminderPages()
        pages.openSchedule()
        XCTAssertEqual(pages.schedule.texts, [
            "提醒我回來過卡", "從今天起算，落在同一個星期幾。",
            "多久提醒一次", "一個月（4 週）", "三個月（12 週）", "建議", "六個月（26 週）", "選日期",
            "什麼時候提醒", "時刻", "晚上 9:00", "更改",
            "下次提醒：2027-02-08（星期一）晚上 9:00", "自然人憑證多半放在家裡，所以預設在晚上。",
            "開啟提醒", "取消",
        ])
        XCTAssertEqual(pages.schedule.options.map(\.selected), [false, true, false, false])
        // The day follows what is chosen.
        pages.choose(.interval(.weeks4))
        pages.setTime(TimeOfDay(hour: 20, minute: 30))
        XCTAssertEqual(pages.schedule.next, "下次提醒：2026-12-14（星期一）晚上 8:30")
        pages.choose(.pick)
        XCTAssertEqual(pages.schedule.pickable, Day(2026, 11, 17)...Day(2027, 11, 16))
        pages.pick(Day(2027, 1, 1))
        XCTAssertEqual(pages.schedule.next, "下次提醒：2027-01-01（星期五）晚上 8:30")
        await pages.confirm()
        XCTAssertEqual(reminders.settings, ReminderSettings(interval: .weeks4, time: TimeOfDay(hour: 20, minute: 30), next: Day(2027, 1, 1)))
        // Opened again with the reminder on: it is saved.
        pages.openSchedule()
        XCTAssertEqual(pages.schedule.confirm, "儲存")
    }

    func testTheScheduleScreenSaysWhyNothingWasSet() async throws {
        let notifier = FakeNotifier()
        notifier.allows = false
        let reminders = Reminders(store: MemoryReminderStore(), notifier: notifier)
        let pages = ReminderPages(ReminderPages.Dependencies(
            reminders: reminders, appCopy: appCopy, serviceName: "", site: URL(string: "https://iamreal.tw")!, version: "dev", open: { _ in }))
        pages.openSchedule()
        await pages.confirm()
        XCTAssertNil(reminders.settings)
        XCTAssertEqual(pages.pages, [.schedule], "it stays")
        XCTAssertEqual(pages.schedule.message, "沒有排提醒：手機不允許這個 app 發通知。到手機的設定打開通知後，再回來開啟提醒。")
    }

    func testTheSettingsSayWhatAppMDWrites() async throws {
        let (reminders, pages) = reminderPages()
        XCTAssertEqual(pages.settings.texts, [
            "返回", "設定", "過卡提醒", "提醒我回來過卡", appCopy("settings.stored"),
            "關於", "版本", "dev", "常見問題", "隱私權說明", "原始碼（GitHub）",
        ])
        XCTAssertTrue(try Repository.text("design/copy/app.md").contains("\n" + appCopy("settings.stored") + "\n"))
        await reminders.turnOn(interval: .weeks12, time: .evening)
        XCTAssertEqual(pages.settings.rows, [
            SettingsScreen.Row(label: "多久一次", value: "三個月", change: "更改"),
            SettingsScreen.Row(label: "時刻", value: "晚上 9:00", change: "更改"),
            SettingsScreen.Row(label: "下次提醒", value: "2027-02-08（星期一）", change: nil),
        ])
        // Its day came: the next is set by the next card proof.
        XCTAssertEqual(ReminderScreens(appCopy: appCopy).settings(threeMonths, notified: true, version: "dev").rows.last?.value, "下次過卡完成後排")
        // Off: the three rows go, and nothing is kept.
        pages.setOn(false)
        XCTAssertEqual(pages.settings.rows, [])
        XCTAssertNil(reminders.settings)
        // On: the schedule screen, where it is turned on.
        pages.setOn(true)
        XCTAssertEqual(pages.pages.last, .schedule)
    }

    func testTheSettingsOpenTheSitesPagesAndTheSource() {
        var opened: [String] = []
        let pages = ReminderPages(ReminderPages.Dependencies(
            reminders: Reminders(store: MemoryReminderStore(), notifier: FakeNotifier()), appCopy: appCopy, serviceName: "",
            site: URL(string: "https://test.iamreal.tw")!, version: "dev", open: { opened.append($0.absoluteString) }))
        pages.openFAQ()
        pages.openPrivacy()
        pages.openSource()
        XCTAssertEqual(opened, ["https://test.iamreal.tw/faq", "https://test.iamreal.tw/privacy", "https://github.com/iamreal-tw/iamreal"])
    }

    /// Step 1 opened from the notification: the note on top, as app.md writes it.
    func testStepOneFromTheNotification() {
        let reminderScreens = ReminderScreens(appCopy: appCopy)
        let asked = screens.before(notice: reminderScreens.fromNotification(snoozed: nil))
        XCTAssertEqual(asked.notice, Notice(text: "這是過卡的提醒。現在不方便的話，可以晚點再做。", button: Button(label: "一週後再提醒我", action: .snoozeReminder)))
        XCTAssertEqual(Array(asked.texts.dropFirst(2)), screens.before().texts)
        let snoozed = reminderScreens.fromNotification(snoozed: ReminderSettings(interval: .weeks12, time: .evening, next: Day(2027, 2, 15)))
        XCTAssertEqual(snoozed, Notice(text: "會在 2027-02-15（星期一）晚上 9:00 再提醒你。", button: nil))
        // The settings are on steps 1 and 6 only.
        XCTAssertEqual(screens.before().settings, Button(label: "設定", action: .openSettings))
        XCTAssertNil(screens.read(reached: 0, running: false, stop: nil).settings)
    }

    /// Where the card goes on an iPhone: drawn under the first sentence of
    /// step 2 before the tap, while it goes on under the system's panel,
    /// and when it stopped; not once the card is read. Its captions and
    /// the sentence VoiceOver reads are card-proof.md's.
    func testTheReadingStepShowsWhereTheCardGoesUntilItIsRead() throws {
        let shown = [
            screens.read(reached: 0, running: false, stop: nil),
            screens.read(reached: 1, running: true, stop: nil),
            screens.read(reached: 1, running: false, stop: .card(.noTap)),
        ]
        for screen in shown {
            guard case .figure(let figure) = screen.blocks[2] else { return XCTFail("no picture after the first sentence: \(screen.blocks)") }
            XCTAssertEqual(figure.captions.map(\.text), ["① 翻到有相機的那面", "② 卡片貼住上方"])
            XCTAssertEqual(figure.captions.map(\.emphasis), ["有相機", "上方"])
            XCTAssertEqual(figure.description, "把手機翻到有相機的那一面，卡片貼住上方")
            document.check(screen)
        }
        let read = screens.read(reached: 4, running: false, stop: nil)
        XCTAssertFalse(read.blocks.contains { if case .figure = $0 { return true } else { return false } })
    }

    /// The card left during the first tap: step 2 says so, and the same tap is done again.
    func testACardThatLeftTheFirstTapIsTappedAgain() {
        let screen = screens.read(reached: 1, running: false, stop: .card(.dropped(pinSent: false)))
        XCTAssertTrue(screen.texts.contains(copy("app_stops.read_dropped")))
        XCTAssertEqual(screen.buttons.map(\.action), [.readCard])
        XCTAssertEqual(screen.buttons.map(\.label), [copy("app_read.tap_again")])
        document.check(screen)
    }

    /// The stops only the app has, with the card: each sentence is card-proof.md's.
    func testTheCardsOwnStopsAreInTheDocument() {
        for (stop, key) in [(Flow.Stop.card(.channel), "app_stops.channel"), (.card(.firstGeneration), "app_stops.first_generation"), (.card(.locked), "stops.card_locked")] {
            XCTAssertEqual(screens.message(stop, tap: 2), [copy(key)])
        }
        document.check(screens.pin(name: "王小明", state: .waiting(copy("app_pin.pin_format"))))
        document.check(screens.pin(name: "王小明", state: .waiting(screens.message(.card(.channel), tap: 2).first)))
        document.check(screens.progress(reached: 1, stop: .card(.channel)))
        document.check(screens.read(reached: 1, running: false, stop: .card(.firstGeneration)))
    }

    /// No screen links out (docs/design/principles.md, principle 1), but
    /// for step 1's two ways to a card: what a button opens is the card's
    /// page, the account's, the share sheet.
    func testNoScreenOpensAHelpPage() {
        for (name, screen) in firstDeclaration() + laterCardProofs() {
            XCTAssertFalse(screen.texts.contains("了解更多"), name)
        }
    }

    func testTheScreensAsTheAppDrawsThem() async throws {
        guard #available(iOS 16.4, *) else { throw XCTSkip("pictures are drawn on iOS 16.4 or later") }
        for (name, screen) in firstDeclaration() + laterCardProofs() {
            let view = ScreenView(screen: screen, copy: copy, pinText: .constant(name.contains("-3-") ? "123456" : ""), perform: { _ in }, type: { _, _ in }, unscrolled: true)
            let drawn = await Self.draw(view, height: nil)
            let image = try XCTUnwrap(drawn)
            XCTAssertEqual(image.size.width, 390)
            try Self.save(image, as: name)
        }
        // The reminder's: the done screen asking, step 1 from the
        // notification, the schedule screen, the settings with the reminder on.
        let (_, done) = declaration()
        let reminderScreens: [(String, Screen)] = [
            ("app-reminder-1-done-phone", screens.done(done, single: "Threads", copied: false, reminder: .ask(threeMonths))),
            ("app-reminder-4-from-notification-phone", screens.before(notice: ReminderScreens(appCopy: appCopy).fromNotification(snoozed: nil))),
        ]
        for (name, screen) in reminderScreens {
            let drawn = await Self.draw(ScreenView(screen: screen, copy: copy, pinText: .constant(""), perform: { _ in }, type: { _, _ in }, unscrolled: true), height: nil)
            try Self.save(try XCTUnwrap(drawn), as: name)
        }
        let (reminders, pages) = reminderPages()
        pages.openSchedule()
        let schedule = await Self.draw(ScheduleView(pages: pages, unscrolled: true), height: nil)
        try Self.save(try XCTUnwrap(schedule), as: "app-reminder-2-schedule-phone")
        await reminders.turnOn(interval: .weeks12, time: .evening)
        let settings = await Self.draw(SettingsView(pages: pages, unscrolled: true), height: nil)
        try Self.save(try XCTUnwrap(settings), as: "app-settings-phone")

        let splashView = SplashView(appCopy: Copy(json: try Repository.data("design/copy/app.json")))
        let drawnSplash = await Self.draw(splashView, height: 844)
        let splash = try XCTUnwrap(drawnSplash)
        try Self.save(splash, as: "app-splash-phone")
    }

    // ---------------------------------------------------------------------------

    /// `view` 390 points wide, as tall as it is (or `height`), one pixel a
    /// point, once the done screen's mark has stood up.
    @available(iOS 16.4, *)
    private static func draw<V: View>(_ view: V, height: CGFloat?) async -> UIImage? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return nil }
        let host = UIHostingController(rootView: view)
        host.safeAreaRegions = []
        let size = CGSize(width: 390, height: height ?? host.sizeThatFits(in: CGSize(width: 390, height: CGFloat.greatestFiniteMagnitude)).height.rounded(.up))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        return image
    }

    private static func save(_ image: UIImage, as name: String) throws {
        let directory = Repository.root.appendingPathComponent("web/test-output/app/screens-ios")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}
