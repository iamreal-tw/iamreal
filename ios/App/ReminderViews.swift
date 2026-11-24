import SwiftUI

/// The top of every screen: the mark of the test log, then the mark and
/// the service's name, or the way back; on the right, a link.
struct AppHeader: View {
    /// The service's name, where there is no way back.
    var name: String
    /// "返回", in the place of the mark and the name.
    var back: (label: String, action: () -> Void)?
    var link: (label: String, action: () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ScreenCopy.testProofLog)
                .font(Theme.body(Theme.sizeSmall, Theme.weightHeading))
                .foregroundColor(Theme.ink.color)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius.value).stroke(Theme.ink.color, lineWidth: 1))
            HStack(spacing: 8) {
                if let back {
                    SwiftUI.Button(action: back.action) {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                            Text(back.label).font(Theme.body(Theme.sizeBody))
                        }
                        .foregroundColor(Theme.ink.color)
                        .frame(minHeight: Theme.minTarget.value)
                    }
                } else {
                    Mark().frame(width: 26, height: 26)
                    Text(name)
                        .font(Theme.display(Theme.sizeBody))
                        .foregroundColor(Theme.ink.color)
                }
                Spacer(minLength: 8)
                if let link {
                    SwiftUI.Button(action: link.action) {
                        Text(link.label).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.ink.color)
                            .frame(minHeight: Theme.minTarget.value)
                    }
                }
            }
            .frame(minHeight: 30)
        }
        .padding(.horizontal, Theme.gutter.value)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().frame(height: 1).foregroundColor(Theme.line.color), alignment: .bottom)
    }
}

/// The parts the two reminder screens share with the card proof's.
private enum Parts {
    static func label(_ text: String) -> some View {
        Text(text).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.mute.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 10)
    }

    static func link(_ text: String, action: @escaping () -> Void) -> some View {
        SwiftUI.Button(action: action) {
            Text(text).font(Theme.body(Theme.sizeBody)).underline().foregroundColor(Theme.you.color)
                .frame(minHeight: Theme.minTarget.value)
        }
    }

    static func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0) {
            content().frame(minHeight: 52)
            Divider().overlay(Theme.line.color)
        }
    }

    static func button(_ text: String, main: Bool, action: @escaping () -> Void) -> some View {
        SwiftUI.Button(action: action) {
            Text(text)
                .font(Theme.body(Theme.sizeBody, Theme.weightHeading))
                .foregroundColor(main ? Theme.bg.color : Theme.ink.color)
                .frame(maxWidth: .infinity, minHeight: Theme.buttonHeight.value)
                .background(main ? Theme.you.color : Theme.bg.color)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius.value).stroke(main ? Theme.you.color : Theme.ink.color, lineWidth: 1.5))
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius.value))
        }
    }
}

extension Day {
    /// Noon of the day on the phone's calendar: for the system's date picker.
    var date: Date {
        Calendar.current.date(from: DateComponents(year: year, month: month, day: day, hour: 12)) ?? Date()
    }
}

/// The screen to choose the interval and time
/// (design/screens/app-reminder-2-schedule-phone.png).
struct ScheduleView: View {
    @ObservedObject var pages: ReminderPages
    /// The system's pickers, over the screen.
    @State private var pickingDay = false
    @State private var changingTime = false
    /// The whole screen, not scrolled: for pictures of it.
    var unscrolled = false

    var body: some View {
        let screen = pages.schedule
        VStack(spacing: 0) {
            AppHeader(name: pages.serviceName)
            if unscrolled {
                content(screen)
                Spacer(minLength: 0)
            } else {
                ScrollView { content(screen) }
            }
        }
        .background(Theme.bg.color.ignoresSafeArea())
        .foregroundColor(Theme.text.color)
        .environment(\.colorScheme, .light)
        .sheet(isPresented: $pickingDay) {
            let range = pages.pickable
            DatePicker("", selection: Binding(get: { pages.next.date }, set: { pages.pick(Day($0)); pickingDay = false }), in: range.lowerBound.date...range.upperBound.date, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
                .accentColor(Theme.ink.color)
                .padding(Theme.gutter.value)
        }
        .sheet(isPresented: $changingTime) {
            DatePicker("", selection: Binding(get: { time(pages.chosenTime) }, set: { pages.setTime(timeOfDay($0)) }), displayedComponents: .hourAndMinute)
                .datePickerStyle(.wheel)
                .labelsHidden()
                .padding(Theme.gutter.value)
        }
    }

    private func content(_ screen: ScheduleScreen) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(screen.title).font(Theme.display(Theme.sizeTitle)).foregroundColor(Theme.ink.color)
                .lineSpacing(Theme.spacing(Theme.leadingTitle, Theme.sizeTitle))
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 28)
            Text(screen.lead).font(Theme.body(Theme.sizeBody))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)

            Parts.label(screen.howOften).padding(.top, 32)
            Divider().overlay(Theme.line.color)
            ForEach(Array(screen.options.enumerated()), id: \.offset) { _, option in
                Parts.row {
                    SwiftUI.Button {
                        pages.choose(option.choice)
                        if option.choice == .pick { pickingDay = true }
                    } label: {
                        HStack(spacing: 14) {
                            ZStack {
                                Circle().stroke(option.selected ? Theme.ink.color : Theme.mute.color, lineWidth: 1.5).frame(width: 20, height: 20)
                                if option.selected { Circle().fill(Theme.ink.color).frame(width: 10, height: 10) }
                            }
                            Text(option.label).font(Theme.body(Theme.sizeBody)).foregroundColor(Theme.ink.color)
                            Spacer()
                            if let note = option.note {
                                Text(note).font(Theme.body(Theme.sizeSmall)).foregroundColor(Theme.mute.color)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(option.selected ? .isSelected : [])
                }
            }

            Parts.label(screen.when).padding(.top, 32)
            Divider().overlay(Theme.line.color)
            Parts.row {
                HStack(spacing: 12) {
                    Text(screen.timeLabel).font(Theme.body(Theme.sizeBody)).foregroundColor(Theme.ink.color)
                    Spacer()
                    Text(screen.time).font(Theme.body(Theme.sizeBody))
                    Parts.link(screen.change) { changingTime = true }
                }
            }

            Text(screen.next).font(Theme.body(Theme.sizeLead, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                .lineSpacing(Theme.spacing(Theme.leadingHeading, Theme.sizeLead))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 28)
            Text(screen.evening).font(Theme.body(Theme.sizeSmall)).foregroundColor(Theme.mute.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)

            if let message = screen.message {
                Text(message).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.ink.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.soft.color)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radius.value))
                    .padding(.top, 24)
            }
            VStack(spacing: 12) {
                Parts.button(screen.confirm, main: true) { Task { await pages.confirm() } }
                Parts.button(screen.cancel, main: false) { pages.back() }
            }
            .padding(.top, 36)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.gutter.value)
        .padding(.bottom, 48)
    }

    private func time(_ time: TimeOfDay) -> Date {
        Calendar.current.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: Date()) ?? Date()
    }

    private func timeOfDay(_ date: Date) -> TimeOfDay {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return TimeOfDay(hour: parts.hour ?? 21, minute: parts.minute ?? 0)
    }
}

/// The settings (design/screens/app-settings-phone.png).
struct SettingsView: View {
    @ObservedObject var pages: ReminderPages
    var unscrolled = false

    var body: some View {
        let screen = pages.settings
        VStack(spacing: 0) {
            AppHeader(name: pages.serviceName, back: (screen.back, { pages.back() }))
            if unscrolled {
                content(screen)
                Spacer(minLength: 0)
            } else {
                ScrollView { content(screen) }
            }
        }
        .background(Theme.bg.color.ignoresSafeArea())
        .foregroundColor(Theme.text.color)
        .environment(\.colorScheme, .light)
        .onAppear { pages.refreshSettings() }
    }

    private func content(_ screen: SettingsScreen) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(screen.title).font(Theme.display(Theme.sizeTitle)).foregroundColor(Theme.ink.color)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 28)

            Parts.label(screen.reminder).padding(.top, 28)
            Divider().overlay(Theme.line.color)
            Parts.row {
                Toggle(isOn: Binding(get: { screen.on }, set: { pages.setOn($0) })) {
                    Text(screen.toggle).font(Theme.body(Theme.sizeBody)).foregroundColor(Theme.ink.color)
                }
                .toggleStyle(SwitchToggleStyle(tint: Theme.ink.color))
            }
            ForEach(Array(screen.rows.enumerated()), id: \.offset) { _, row in
                Parts.row {
                    HStack(spacing: 12) {
                        Text(row.label).font(Theme.body(Theme.sizeBody)).foregroundColor(Theme.ink.color)
                        Spacer()
                        Text(row.value).font(Theme.body(Theme.sizeBody))
                        if let change = row.change { Parts.link(change) { pages.openSchedule() } }
                    }
                }
            }
            Text(screen.stored).font(Theme.body(Theme.sizeSmall)).foregroundColor(Theme.mute.color)
                .lineSpacing(Theme.spacing(Theme.leadingSmall, Theme.sizeSmall))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)

            Parts.label(screen.about).padding(.top, 36)
            Divider().overlay(Theme.line.color)
            Parts.row {
                HStack {
                    Text(screen.version.label).font(Theme.body(Theme.sizeBody)).foregroundColor(Theme.ink.color)
                    Spacer()
                    Text(screen.version.value).font(Theme.body(Theme.sizeBody))
                }
            }
            ForEach(Array(zip(screen.links, [pages.openFAQ, pages.openPrivacy, pages.openSource]).enumerated()), id: \.offset) { _, link in
                Parts.row {
                    SwiftUI.Button(action: link.1) {
                        HStack {
                            Text(link.0).font(Theme.body(Theme.sizeBody)).foregroundColor(Theme.ink.color)
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.mute.color)
                        }
                        .contentShape(Rectangle())
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.gutter.value)
        .padding(.bottom, 48)
    }
}
