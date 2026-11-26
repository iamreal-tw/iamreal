import Foundation
import UserNotifications

/// The two screens of the reminder, over the card proof: the settings,
/// and the screen to choose the interval and time (from step 7 of the
/// card proof or the settings). What they show is `schedule` and `settings`; what
/// their buttons do is here.
@MainActor
final class ReminderPages: ObservableObject {
    enum Page: Equatable {
        case settings
        case schedule
    }

    struct Dependencies {
        var reminders: Reminders
        var appCopy: Copy
        /// The service's name, for the header (card-proof.json's).
        var serviceName: String
        /// The site of this build: the questions and the privacy notice are its pages.
        var site: URL
        /// This app's version, as the settings write it.
        var version: String
        /// Opens an address in the browser.
        var open: (URL) -> Void
    }

    /// The screens on top of the card proof, the last one showing.
    @Published private(set) var pages: [Page] = []
    @Published private(set) var schedule: ScheduleScreen
    @Published private(set) var settings: SettingsScreen

    private let deps: Dependencies
    private let screens: ReminderScreens

    // What the schedule screen has chosen.
    private var choice: ScheduleScreen.Choice = .interval(.suggested)
    /// The interval kept when a day is picked: the next card proof goes back to it.
    private var interval = Interval.suggested
    private var picked: Day
    private var time = TimeOfDay.evening
    private var refused = false
    /// "開啟提醒" or "儲存" was pressed and the system is being asked.
    private var confirming = false

    init(_ deps: Dependencies) {
        self.deps = deps
        screens = ReminderScreens(appCopy: deps.appCopy)
        picked = deps.reminders.pickable.lowerBound
        let offered = deps.reminders.offered
        schedule = screens.schedule(choice: .interval(offered.interval), time: offered.time, next: offered.next, pickable: deps.reminders.pickable, on: false, refused: false)
        settings = screens.settings(nil, notified: false, version: deps.version)
        drawSettings()
        deps.reminders.observe { [weak self] in self?.drawSettings() }
    }

    var serviceName: String { deps.serviceName }

    /// The day the schedule screen has chosen.
    var next: Day {
        choice == .pick ? picked : interval.after(deps.reminders.today)
    }

    /// The days that may be picked.
    var pickable: ClosedRange<Day> { deps.reminders.pickable }

    var chosenTime: TimeOfDay { time }

    // The settings --------------------------------------------------------------------

    func openSettings() {
        pages = [.settings]
        drawSettings()
    }

    /// Draws the settings again: shown again, the reminder may have come since.
    func refreshSettings() {
        drawSettings()
    }

    /// The switch: on opens the schedule screen, where it is turned on; off
    /// takes the reminder away and deletes what was kept.
    func setOn(_ on: Bool) {
        if on {
            openSchedule()
        } else {
            deps.reminders.turnOff()
        }
    }

    func openFAQ() { deps.open(deps.site.appendingPathComponent("faq")) }
    func openPrivacy() { deps.open(deps.site.appendingPathComponent("privacy")) }
    func openSource() {
        if let source = URL(string: "https://github.com/iamreal-tw/iamreal") { deps.open(source) }
    }

    private func drawSettings() {
        let reminders = deps.reminders
        settings = screens.settings(reminders.settings, notified: reminders.notified, version: deps.version)
    }

    // The schedule screen -----------------------------------------------------------------

    /// From what the phone keeps, or the default: three months, 9:00 in
    /// the evening. A day kept that is not its interval from today was
    /// picked, or put off a week: it is shown picked, so that "儲存" keeps it.
    func openSchedule() {
        let reminders = deps.reminders
        let kept = reminders.settings ?? reminders.offered
        interval = kept.interval
        time = kept.time
        picked = kept.next
        choice = reminders.settings != nil && !reminders.countedFromToday && pickable.contains(kept.next) ? .pick : .interval(interval)
        refused = false
        pages.append(.schedule)
        drawSchedule()
    }

    func choose(_ choice: ScheduleScreen.Choice) {
        self.choice = choice
        if case .interval(let interval) = choice { self.interval = interval }
        drawSchedule()
    }

    func pick(_ day: Day) {
        guard pickable.contains(day) else { return }
        picked = day
        drawSchedule()
    }

    func setTime(_ time: TimeOfDay) {
        self.time = time
        drawSchedule()
    }

    /// "開啟提醒" or "儲存": sets the reminder as chosen, and goes back. When
    /// the system does not let the app notify, nothing is kept and the
    /// screen says so.
    func confirm() async {
        guard !confirming else { return }
        confirming = true
        defer { confirming = false }
        let picked = choice == .pick ? self.picked : nil
        if await deps.reminders.turnOn(interval: interval, time: time, picked: picked) {
            back()
        } else {
            refused = true
            drawSchedule()
        }
    }

    func back() {
        _ = pages.popLast()
    }

    /// Back to the card proof, from either screen.
    func close() {
        pages = []
    }

    private func drawSchedule() {
        schedule = screens.schedule(
            choice: choice, time: time, next: next, pickable: pickable,
            on: deps.reminders.settings != nil, refused: refused)
    }
}

/// The system's notifications: the one reminder, with "一週後再提醒我" on it.
final class SystemNotifier: NSObject, Notifier, UNUserNotificationCenterDelegate {
    private static let identifier = "reminder"
    private static let category = "reminder"
    private static let snooze = "snooze"

    private let center = UNUserNotificationCenter.current()
    private let appCopy: Copy
    /// "一週後再提醒我" was pressed on the notification.
    var snoozed: (() async -> Void)?
    /// The notification was pressed: the app opens at step 1.
    var opened: (() -> Void)?

    init(appCopy: Copy) {
        self.appCopy = appCopy
        super.init()
        let snooze = UNNotificationAction(identifier: Self.snooze, title: appCopy("notification.snooze"), options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [snooze], intentIdentifiers: [], options: [])])
        center.delegate = self
    }

    func authorize() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    func schedule(at moment: Moment) async {
        let content = UNMutableNotificationContent()
        content.title = appCopy("notification.title")
        content.body = appCopy("notification.body")
        content.categoryIdentifier = Self.category
        content.sound = .default
        // The phone's own time zone, whatever it is on that day.
        let request = UNNotificationRequest(identifier: Self.identifier, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: moment.components, repeats: false))
        try? await center.add(request)
    }

    func cancel() {
        center.removePendingNotificationRequests(withIdentifiers: [Self.identifier])
        center.removeDeliveredNotifications(withIdentifiers: [Self.identifier])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier
        Task { @MainActor in
            if action == Self.snooze {
                await self.snoozed?()
            } else if action == UNNotificationDefaultActionIdentifier {
                self.opened?()
            }
            completionHandler()
        }
    }

    /// While the app is open, the notification shows all the same.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
