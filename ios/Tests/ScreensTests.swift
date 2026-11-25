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
        for (_, screen) in firstDeclaration() {
            document.check(screen)
        }
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

    /// No screen links out (docs/design/principles.md, principle 1): what a
    /// button opens is the card's page, the account's, the share sheet.
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

    func testNoScreenOpensAHelpPage() {
        for (name, screen) in firstDeclaration() {
            XCTAssertFalse(screen.texts.contains("了解更多"), name)
        }
    }

    func testTheScreensAsTheAppDrawsThem() async throws {
        guard #available(iOS 16.4, *) else { throw XCTSkip("pictures are drawn on iOS 16.4 or later") }
        for (name, screen) in firstDeclaration() {
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
