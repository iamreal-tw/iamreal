import Foundation

/// How a reminder's day, time and interval are written
/// (design/copy/app.md, the section on days and times).
struct When {
    let appCopy: Copy

    /// `2027-02-08（星期一）`
    func day(_ day: Day) -> String {
        appCopy("when.day", ["date": day.iso, "weekday": weekday(day.weekday)])
    }

    private func weekday(_ number: Int) -> String {
        switch number {
        case 1: return appCopy("when.sunday")
        case 2: return appCopy("when.monday")
        case 3: return appCopy("when.tuesday")
        case 4: return appCopy("when.wednesday")
        case 5: return appCopy("when.thursday")
        case 6: return appCopy("when.friday")
        default: return appCopy("when.saturday")
        }
    }

    /// `晚上 9:00`: the part of the day, a space, the time on a 12-hour clock.
    func time(_ time: TimeOfDay) -> String {
        let part = time.hour < 12 ? appCopy("when.morning") : time.hour < 18 ? appCopy("when.afternoon") : appCopy("when.evening")
        let hour = time.hour % 12 == 0 ? 12 : time.hour % 12
        return part + " " + String(format: "%d:%02d", hour, time.minute)
    }

    /// `三個月`
    func interval(_ interval: Interval) -> String {
        switch interval {
        case .weeks4: return appCopy("interval.weeks_4")
        case .weeks12: return appCopy("interval.weeks_12")
        case .weeks26: return appCopy("interval.weeks_26")
        }
    }
}

/// Which of step 7's screens (design/copy/card-proof.md, step 7): what the
/// phone keeps of the reminder decides.
enum DoneReminder: Equatable {
    /// Nothing is kept: the question, with the day the default would set.
    case ask(ReminderSettings)
    /// The reminder is on, set again by this card proof. `counted`: its
    /// day is its interval from today, not a day picked.
    case on(ReminderSettings, counted: Bool)
}

/// What the screen to choose the interval and time shows
/// (design/copy/app.md, choosing the interval and time).
struct ScheduleScreen: Equatable {
    enum Choice: Equatable {
        case interval(Interval)
        case pick
    }

    struct Option: Equatable {
        var label: String
        /// "建議", on the right of the one suggested.
        var note: String?
        var choice: Choice
        var selected: Bool
    }

    var title: String
    var lead: String
    var howOften: String
    var options: [Option]
    /// The days the picker offers, when a day is to be picked.
    var pickable: ClosedRange<Day>?
    var when: String
    var timeLabel: String
    var time: String
    var change: String
    var next: String
    var evening: String
    /// Why nothing was set.
    var message: String?
    /// "開啟提醒", or "儲存" when the reminder is on.
    var confirm: String
    var cancel: String

    var texts: [String] {
        var texts = [title, lead, howOften]
        for option in options {
            texts.append(option.label)
            if let note = option.note { texts.append(note) }
        }
        texts += [when, timeLabel, time, change, next, evening]
        if let message { texts.append(message) }
        return texts + [confirm, cancel]
    }
}

/// What the settings show (design/copy/app.md, the settings).
struct SettingsScreen: Equatable {
    struct Row: Equatable {
        var label: String
        var value: String
        /// "更改", which opens the screen to choose the interval and time.
        var change: String?
    }

    var back: String
    var title: String
    var reminder: String
    var toggle: String
    var on: Bool
    /// How often, the time, the next reminder: while it is on.
    var rows: [Row]
    var stored: String
    var about: String
    var version: Row
    /// The pages the browser opens: the questions, the privacy notice, the source.
    var links: [String]

    var texts: [String] {
        var texts = [back, title, reminder, toggle]
        for row in rows {
            texts += [row.label, row.value]
            if let change = row.change { texts.append(change) }
        }
        return texts + [stored, about, version.label, version.value] + links
    }
}

/// The reminder's screens, from what the phone keeps and what is being
/// chosen. Pure functions; the sentences come from design/copy/app.json.
struct ReminderScreens {
    let appCopy: Copy
    var when: When { When(appCopy: appCopy) }

    /// `choice`, `time`: what the screen has chosen; `next`: the day that
    /// makes; `pickable`: the days a picked one may be; `on`: the reminder
    /// is on already; `refused`: the system did not let the app notify.
    func schedule(choice: ScheduleScreen.Choice, time: TimeOfDay, next: Day, pickable: ClosedRange<Day>, on: Bool, refused: Bool) -> ScheduleScreen {
        let intervals: [(Interval, String)] = [
            (.weeks4, appCopy("reminder.weeks_4")),
            (.weeks12, appCopy("reminder.weeks_12")),
            (.weeks26, appCopy("reminder.weeks_26")),
        ]
        var options = intervals.map { interval, label in
            ScheduleScreen.Option(
                label: label, note: interval == .suggested ? appCopy("reminder.suggested") : nil,
                choice: .interval(interval), selected: choice == .interval(interval))
        }
        options.append(ScheduleScreen.Option(label: appCopy("reminder.pick_date"), note: nil, choice: .pick, selected: choice == .pick))
        return ScheduleScreen(
            title: appCopy("reminder.title"),
            lead: appCopy("reminder.from_today"),
            howOften: appCopy("reminder.how_often"),
            options: options,
            pickable: choice == .pick ? pickable : nil,
            when: appCopy("reminder.when"),
            timeLabel: appCopy("reminder.time"),
            time: when.time(time),
            change: appCopy("reminder.change"),
            next: appCopy("reminder.next", ["day": when.day(next), "time": when.time(time)]),
            evening: appCopy("reminder.evening"),
            message: refused ? appCopy("reminder.denied") : nil,
            confirm: on ? appCopy("reminder.save") : appCopy("reminder.turn_on"),
            cancel: appCopy("reminder.cancel"))
    }

    /// `settings`: what the phone keeps; `notified`: its reminder came
    /// already; `version`: of this app.
    func settings(_ settings: ReminderSettings?, notified: Bool, version: String) -> SettingsScreen {
        var rows: [SettingsScreen.Row] = []
        if let settings {
            rows = [
                .init(label: appCopy("settings.interval"), value: when.interval(settings.interval), change: appCopy("reminder.change")),
                .init(label: appCopy("settings.time"), value: when.time(settings.time), change: appCopy("reminder.change")),
                .init(label: appCopy("settings.next"), value: notified ? appCopy("settings.next_none") : when.day(settings.next), change: nil),
            ]
        }
        return SettingsScreen(
            back: appCopy("settings.back"),
            title: appCopy("settings.title"),
            reminder: appCopy("settings.reminder"),
            toggle: appCopy("settings.switch"),
            on: settings != nil,
            rows: rows,
            stored: appCopy("settings.stored"),
            about: appCopy("settings.about"),
            version: .init(label: appCopy("settings.version"), value: version, change: nil),
            links: [appCopy("settings.faq"), appCopy("settings.privacy"), appCopy("settings.source")])
    }

    /// On top of step 1, opened from the notification: the note and its
    /// button, or once pressed when the reminder comes again.
    func fromNotification(snoozed: ReminderSettings?) -> Notice {
        if let snoozed {
            return Notice(text: appCopy("from_notification.snoozed", ["day": when.day(snoozed.next), "time": when.time(snoozed.time)]), button: nil)
        }
        return Notice(text: appCopy("from_notification.note"), button: Button(label: appCopy("notification.snooze"), action: .snoozeReminder))
    }
}
