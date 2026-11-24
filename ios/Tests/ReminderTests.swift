import XCTest
@testable import IamrealApp

/// The reminder to come back for a card proof (#93): which day it is set
/// for, and what the phone keeps of it. No notification is sent: the
/// system's is replaced by a notifier that writes down what it was asked.
@MainActor
final class ReminderTests: XCTestCase {
    private var store: MemoryReminderStore!
    private var notifier: FakeNotifier!
    private var now = at(2026, 11, 16) // a Monday

    /// Noon of a day in Taiwan.
    private static func at(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0) -> Date {
        taipei.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    private static let taipei: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Taipei")!
        return calendar
    }()

    override func setUp() {
        store = MemoryReminderStore()
        notifier = FakeNotifier()
    }

    private func reminders() -> Reminders {
        Reminders(store: store, notifier: notifier, clock: { [unowned self] in self.now }, calendar: Self.taipei)
    }

    func testThreeMonthsIsTwelveWeeksOnTheSameWeekday() async {
        let reminders = reminders()
        let on = await reminders.turnOn(interval: .weeks12, time: .evening)
        XCTAssertTrue(on)
        XCTAssertTrue(reminders.countedFromToday)
        XCTAssertEqual(reminders.settings?.next, Day(2027, 2, 8))
        XCTAssertEqual(reminders.settings?.next.weekday, 2) // Monday, as today
        XCTAssertEqual(notifier.scheduled, [Moment(day: Day(2027, 2, 8), time: TimeOfDay(hour: 21, minute: 0))])
    }

    func testOneMonthIsFourWeeksAndSixMonthsTwentySix() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks4, time: .evening)
        XCTAssertEqual(store.kept?.next, Day(2026, 12, 14))
        await reminders.turnOn(interval: .weeks26, time: TimeOfDay(hour: 7, minute: 30))
        XCTAssertEqual(store.kept, ReminderSettings(interval: .weeks26, time: TimeOfDay(hour: 7, minute: 30), next: Day(2027, 5, 17)))
        XCTAssertEqual(notifier.scheduled.last, Moment(day: Day(2027, 5, 17), time: TimeOfDay(hour: 7, minute: 30)))
        XCTAssertEqual(Day(2027, 5, 17).weekday, Day(2026, 11, 16).weekday)
    }

    /// Across the end of February and of a year, and from another weekday.
    func testTheWeeksAreCountedAcrossMonthsAndYears() async {
        now = Self.at(2027, 12, 30) // a Thursday
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks12, time: .evening)
        XCTAssertEqual(reminders.settings?.next, Day(2028, 3, 23))
        XCTAssertEqual(reminders.settings?.next.weekday, 5)
    }

    func testAPickedDayIsForThisTimeOnly() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks12, time: .evening, picked: Day(2027, 1, 1))
        XCTAssertEqual(store.kept, ReminderSettings(interval: .weeks12, time: .evening, next: Day(2027, 1, 1)))
        // The next card proof goes back to the interval.
        now = Self.at(2026, 12, 31)
        await reminders.cardProofDone()
        XCTAssertEqual(store.kept?.next, Day(2027, 3, 25))
        XCTAssertEqual(notifier.scheduled.last, Moment(day: Day(2027, 3, 25), time: .evening))
    }

    func testADayFromTomorrowToAYearFromTodayCanBePicked() async {
        let reminders = reminders()
        XCTAssertEqual(reminders.pickable, Day(2026, 11, 17)...Day(2027, 11, 16))
        // Outside: the interval, as if no day was picked.
        await reminders.turnOn(interval: .weeks4, time: .evening, picked: Day(2026, 11, 16))
        XCTAssertEqual(store.kept?.next, Day(2026, 12, 14))
        await reminders.turnOn(interval: .weeks4, time: .evening, picked: Day(2027, 11, 17))
        XCTAssertEqual(store.kept?.next, Day(2026, 12, 14))
        await reminders.turnOn(interval: .weeks4, time: .evening, picked: Day(2027, 11, 16))
        XCTAssertEqual(store.kept?.next, Day(2027, 11, 16))
    }

    func testEveryCardProofSetsTheReminderAgainAsLastChosen() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks4, time: TimeOfDay(hour: 20, minute: 15))
        now = Self.at(2026, 12, 3)
        await reminders.cardProofDone()
        XCTAssertEqual(store.kept, ReminderSettings(interval: .weeks4, time: TimeOfDay(hour: 20, minute: 15), next: Day(2026, 12, 31)))
        XCTAssertEqual(notifier.scheduled.last, Moment(day: Day(2026, 12, 31), time: TimeOfDay(hour: 20, minute: 15)))
        // Not asked again.
        XCTAssertEqual(notifier.asked, 1)
    }

    func testACardProofSetsNothingWhileTheReminderIsOff() async {
        let reminders = reminders()
        await reminders.cardProofDone()
        XCTAssertNil(store.kept)
        XCTAssertEqual(notifier.scheduled, [])
        XCTAssertEqual(notifier.asked, 0)
    }

    func testAWeekLaterComesSevenDaysFromTodayAtTheSameTime() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks12, time: TimeOfDay(hour: 21, minute: 30))
        now = Self.at(2027, 2, 8)
        await reminders.snooze()
        XCTAssertEqual(store.kept, ReminderSettings(interval: .weeks12, time: TimeOfDay(hour: 21, minute: 30), next: Day(2027, 2, 15)))
        XCTAssertEqual(notifier.scheduled.last, Moment(day: Day(2027, 2, 15), time: TimeOfDay(hour: 21, minute: 30)))
        // As many times as the cardholder asks.
        now = Self.at(2027, 2, 16)
        await reminders.snooze()
        XCTAssertEqual(store.kept?.next, Day(2027, 2, 23))
        XCTAssertEqual(reminders.settings?.next, Day(2027, 2, 23))
    }

    func testAWeekLaterDoesNothingWhileTheReminderIsOff() async {
        let reminders = reminders()
        await reminders.snooze()
        XCTAssertNil(store.kept)
        XCTAssertEqual(notifier.scheduled, [])
    }

    func testTurningTheReminderOffLeavesNothing() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks12, time: .evening)
        reminders.turnOff()
        XCTAssertNil(store.kept)
        XCTAssertNil(reminders.settings)
        XCTAssertEqual(notifier.cancelled, 1)
        XCTAssertEqual(notifier.scheduled, [])
    }

    func testWhenTheSystemSaysNoNothingIsKept() async {
        notifier.allows = false
        let reminders = reminders()
        let on = await reminders.turnOn(interval: .weeks12, time: .evening)
        XCTAssertFalse(on)
        XCTAssertNil(store.kept)
        XCTAssertEqual(notifier.scheduled, [])
    }

    func testAPickedOrPutOffDayIsNotCountedFromToday() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks12, time: .evening, picked: Day(2027, 1, 1))
        XCTAssertFalse(reminders.countedFromToday)
        await reminders.turnOn(interval: .weeks12, time: .evening)
        await reminders.snooze()
        XCTAssertFalse(reminders.countedFromToday)
    }

    /// Once its day and time have come, the reminder was notified.
    func testTheReminderWasNotifiedOnceItsTimeCame() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks4, time: TimeOfDay(hour: 21, minute: 0))
        now = Self.at(2026, 12, 14, 20, 59)
        XCTAssertFalse(reminders.notified)
        now = Self.at(2026, 12, 14, 21, 0)
        XCTAssertTrue(reminders.notified)
    }

    func testTheScreensAreToldOfEveryChange() async {
        let reminders = reminders()
        var told = 0
        reminders.observe { told += 1 }
        await reminders.turnOn(interval: .weeks12, time: .evening)
        reminders.turnOff()
        XCTAssertEqual(told, 2)
    }

    // The screens ----------------------------------------------------------------------

    private func pages(_ reminders: Reminders) -> ReminderPages {
        ReminderPages(ReminderPages.Dependencies(
            reminders: reminders, appCopy: Copy.bundled("app"), serviceName: "", site: URL(string: "https://iamreal.tw")!,
            version: "dev", open: { _ in }))
    }

    /// A day picked, or put off a week, is kept when the schedule is opened
    /// again and saved as it is.
    func testAPickedDayStaysPickedWhenTheScheduleIsSavedAgain() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks26, time: .evening, picked: Day(2027, 1, 1))
        let pages = pages(reminders)
        pages.openSchedule()
        XCTAssertEqual(pages.schedule.options.map(\.selected), [false, false, false, true])
        await pages.confirm()
        XCTAssertEqual(store.kept, ReminderSettings(interval: .weeks26, time: .evening, next: Day(2027, 1, 1)))
        // Counted from today: the interval is shown chosen.
        await reminders.turnOn(interval: .weeks4, time: .evening)
        pages.openSchedule()
        XCTAssertEqual(pages.schedule.options.map(\.selected), [true, false, false, false])
    }

    /// Opened from the notification, step 1 says so until a card proof is
    /// done; "一週後再提醒我", there or on the notification, says when it comes now.
    func testStepOneFromTheReminderUntilACardProofIsDone() async {
        let reminders = reminders()
        await reminders.turnOn(interval: .weeks12, time: .evening)
        let model = CardProofModel(CardProofModel.Dependencies(
            flow: CardProofFlow.Dependencies(
                proofLog: .test,
                backend: HTTPBackend(site: URL(string: "https://test.invalid")!, publicFiles: URL(string: "https://test.invalid")!),
                card: NoCardReader(), clock: Date.init, crlNumbers: MemoryCRLNumbers(),
                openSession: { try DeviceCore.Session(.test) }, proofFiles: BundledFile.proofFiles(for:)),
            copy: Copy.bundled(), appCopy: Copy.bundled("app"), reminders: reminders,
            openSchedule: {}, openSettings: {}, site: URL(string: "https://test.invalid")!,
            open: { _ in }, copyText: { _ in }, share: { _ in }))
        XCTAssertNil(model.screen.notice)
        model.openedFromReminder()
        XCTAssertEqual(model.screen.notice?.button?.label, "一週後再提醒我")
        // Step 2 and back: still there.
        model.perform(.start)
        XCTAssertEqual(model.screen.step, 2)
        model.perform(.back)
        XCTAssertEqual(model.screen.step, 1)
        XCTAssertNotNil(model.screen.notice?.button)
        // Pressed on the notification while step 1 is up.
        now = Self.at(2026, 11, 20)
        await model.snoozeReminder()
        XCTAssertEqual(model.screen.notice, Notice(text: "會在 2026-11-27（星期五）晚上 9:00 再提醒你。", button: nil))
        XCTAssertEqual(store.kept?.next, Day(2026, 11, 27))
    }

    /// The settings as the phone keeps them: turned off, none of them is left.
    func testThePhoneKeepsNoSettingOnceTheReminderIsOff() async throws {
        let name = "reminder-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        defer { defaults.removePersistentDomain(forName: name) }
        let stored = StoredReminder(defaults: defaults)
        let reminders = Reminders(store: stored, notifier: notifier, clock: { Self.at(2026, 11, 16) }, calendar: Self.taipei)
        await reminders.turnOn(interval: .weeks26, time: TimeOfDay(hour: 8, minute: 5))
        XCTAssertEqual(defaults.persistentDomain(forName: name)?.count, 4, "on, interval, time, next")
        // Read back as kept.
        XCTAssertEqual(StoredReminder(defaults: defaults).load(), ReminderSettings(interval: .weeks26, time: TimeOfDay(hour: 8, minute: 5), next: Day(2027, 5, 17)))
        reminders.turnOff()
        XCTAssertTrue(defaults.persistentDomain(forName: name)?.isEmpty ?? true, "\(defaults.persistentDomain(forName: name) ?? [:])")
        XCTAssertNil(StoredReminder(defaults: defaults).load())
    }
}

/// The settings in memory, as the phone would keep them.
final class MemoryReminderStore: ReminderStore {
    var kept: ReminderSettings?
    func load() -> ReminderSettings? { kept }
    func save(_ settings: ReminderSettings) { kept = settings }
    func clear() { kept = nil }
}

/// A notifier that sends nothing: it writes down what it was asked.
final class FakeNotifier: Notifier {
    /// What the system answers when asked for notifications.
    var allows = true
    private(set) var asked = 0
    private(set) var scheduled: [Moment] = []
    private(set) var cancelled = 0

    func authorize() async -> Bool {
        asked += 1
        return allows
    }

    func schedule(at moment: Moment) async { scheduled.append(moment) }

    func cancel() {
        cancelled += 1
        scheduled = []
    }
}
