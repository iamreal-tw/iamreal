import Foundation

/// A day of the phone's calendar.
struct Day: Equatable, Comparable, Hashable {
    let year: Int
    let month: Int
    let day: Int

    init(_ year: Int, _ month: Int, _ day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// The day of `date` on the phone's calendar.
    init(_ date: Date, calendar: Calendar = .current) {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        self.init(parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// `2027-02-08`; nil when it is not a day written so.
    init?(iso: String) {
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, iso.count == 10 else { return nil }
        let day = Day(parts[0], parts[1], parts[2])
        guard day.adding(days: 0) == day else { return nil }
        self = day
    }

    var iso: String { String(format: "%04d-%02d-%02d", year, month, day) }

    /// Days are counted on the Gregorian calendar alone, without a time
    /// zone: a day is a day, whatever summer time does to its hours.
    private static let counting: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        return calendar
    }()

    private var noon: Date {
        Self.counting.date(from: DateComponents(year: year, month: month, day: day, hour: 12)) ?? Date(timeIntervalSince1970: 0)
    }

    func adding(days: Int) -> Day {
        Day(Self.counting.date(byAdding: .day, value: days, to: noon) ?? noon, calendar: Self.counting)
    }

    func adding(years: Int) -> Day {
        Day(Self.counting.date(byAdding: .year, value: years, to: noon) ?? noon, calendar: Self.counting)
    }

    /// 1 for Sunday, 2 for Monday, … 7 for Saturday.
    var weekday: Int { Self.counting.component(.weekday, from: noon) }

    static func < (a: Day, b: Day) -> Bool { (a.year, a.month, a.day) < (b.year, b.month, b.day) }
}

/// A time of day, to the minute.
struct TimeOfDay: Equatable {
    let hour: Int
    let minute: Int

    /// 9:00 in the evening: a card is mostly kept at home (#93).
    static let evening = TimeOfDay(hour: 21, minute: 0)
}

/// When a notification is to come: a day, at a time of it.
struct Moment: Equatable {
    let day: Day
    let time: TimeOfDay
}

/// How often the reminder comes, from the day of a card proof (#93).
enum Interval: Int, CaseIterable {
    case weeks4 = 4
    case weeks12 = 12
    case weeks26 = 26

    /// Three months: the one suggested, and the one chosen until another is.
    static let suggested = Interval.weeks12

    /// The reminder's day after a card proof on `day`: whole weeks, so
    /// the same weekday.
    func after(_ day: Day) -> Day { day.adding(days: rawValue * 7) }
}

/// What the phone keeps of the reminder, and nothing else (ADR-0016, "app
/// 在手機上留下什麼"): that it is on, the interval, the time, the next
/// reminder's day. There is none while it is off.
struct ReminderSettings: Equatable {
    var interval: Interval
    var time: TimeOfDay
    var next: Day
}

/// Where the settings are kept.
protocol ReminderStore {
    func load() -> ReminderSettings?
    func save(_ settings: ReminderSettings)
    /// Deletes all of them.
    func clear()
}

/// The system's notifications.
protocol Notifier {
    /// Whether the app may notify. The system asks the cardholder the first time.
    func authorize() async -> Bool
    /// The one reminder, at `moment`, in the place of any before.
    func schedule(at moment: Moment) async
    /// Takes the reminder away.
    func cancel()
}

/// The reminder: turned on, changed, turned off, put off a week, set again
/// after every card proof. What it sets is kept in `store` and handed to
/// `notifier`; nothing goes to a server.
@MainActor
final class Reminders {
    /// The settings kept, nil while the reminder is off.
    private(set) var settings: ReminderSettings? {
        didSet { if settings != oldValue { changed?() } }
    }
    /// Called when `settings` changed: the screens that show them are drawn again.
    var changed: (() -> Void)?

    private let store: ReminderStore
    private let notifier: Notifier
    private let clock: () -> Date
    private let calendar: Calendar

    /// `calendar`: the phone's, whose days and time zone the reminder keeps.
    init(store: ReminderStore, notifier: Notifier, clock: @escaping () -> Date = Date.init, calendar: Calendar = .current) {
        self.store = store
        self.notifier = notifier
        self.clock = clock
        self.calendar = calendar
        settings = store.load()
    }

    var today: Day { Day(clock(), calendar: calendar) }

    /// The days that may be picked: tomorrow to a year from today.
    var pickable: ClosedRange<Day> {
        let today = today
        return today.adding(days: 1)...today.adding(years: 1)
    }

    /// The reminder's day is its interval from today: it was not picked or put off.
    var countedFromToday: Bool {
        guard let settings else { return false }
        return settings.next == settings.interval.after(today)
    }

    /// The reminder was notified: its day and time have come.
    var notified: Bool {
        guard let settings else { return false }
        let moment = DateComponents(year: settings.next.year, month: settings.next.month, day: settings.next.day, hour: settings.time.hour, minute: settings.time.minute)
        guard let date = calendar.date(from: moment) else { return false }
        return date <= clock()
    }

    /// Turns the reminder on, or changes it: every `interval` from today,
    /// or once on `picked` and every `interval` after the next card proof.
    /// Asks the system for notifications first; when it says no nothing is
    /// kept, and false is returned.
    @discardableResult
    func turnOn(interval: Interval, time: TimeOfDay, picked: Day? = nil) async -> Bool {
        guard await notifier.authorize() else { return false }
        let next = picked.flatMap { pickable.contains($0) ? $0 : nil } ?? interval.after(today)
        await set(ReminderSettings(interval: interval, time: time, next: next))
        return true
    }

    /// After a card proof: the reminder, if it is on, comes again after
    /// the interval last chosen, from today.
    func cardProofDone() async {
        guard let settings else { return }
        await set(ReminderSettings(interval: settings.interval, time: settings.time, next: settings.interval.after(today)))
    }

    /// "一週後再提醒我": the reminder, if it is on, comes again 7 days from
    /// today at its time. As many times as asked.
    func snooze() async {
        guard let settings else { return }
        await set(ReminderSettings(interval: settings.interval, time: settings.time, next: today.adding(days: 7)))
    }

    /// Takes the reminder away and deletes everything kept of it.
    func turnOff() {
        notifier.cancel()
        store.clear()
        settings = nil
    }

    private func set(_ settings: ReminderSettings) async {
        store.save(settings)
        await notifier.schedule(at: Moment(day: settings.next, time: settings.time))
        self.settings = settings
    }
}

/// The settings, kept in the app's preferences: four values, all deleted
/// when the reminder is turned off.
struct StoredReminder: ReminderStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private enum Key {
        static let on = "reminder-on"
        static let interval = "reminder-interval-weeks"
        static let time = "reminder-time"
        static let next = "reminder-next"
        static let all = [on, interval, time, next]
    }

    func load() -> ReminderSettings? {
        guard defaults.bool(forKey: Key.on),
              let interval = Interval(rawValue: defaults.integer(forKey: Key.interval)),
              let next = defaults.string(forKey: Key.next).flatMap(Day.init(iso:))
        else { return nil }
        let minutes = defaults.integer(forKey: Key.time)
        guard (0..<24 * 60).contains(minutes) else { return nil }
        return ReminderSettings(interval: interval, time: TimeOfDay(hour: minutes / 60, minute: minutes % 60), next: next)
    }

    func save(_ settings: ReminderSettings) {
        defaults.set(true, forKey: Key.on)
        defaults.set(settings.interval.rawValue, forKey: Key.interval)
        defaults.set(settings.time.hour * 60 + settings.time.minute, forKey: Key.time)
        defaults.set(settings.next.iso, forKey: Key.next)
    }

    func clear() {
        for key in Key.all { defaults.removeObject(forKey: key) }
    }
}
