import SwiftUI
import UIKit

/// The iOS app: the splash screen (SplashView), then the card proof, eight
/// steps (CardProofView); over it the settings and the screen to choose
/// the reminder's interval and time (ReminderViews).
@main
struct IamrealApp: App {
    @StateObject private var model: CardProofModel
    @StateObject private var pages: ReminderPages
    @State private var opening = true
    @Environment(\.scenePhase) private var scenePhase
    /// The system's notifications. Made as the app starts, before the
    /// system hands it what was pressed on a notification.
    private let notifier: SystemNotifier

    init() {
        let appCopy = Copy.bundled("app")
        let copy = Copy.bundled()
        let notifier = SystemNotifier(appCopy: appCopy)
        let reminders = Reminders(store: StoredReminder(), notifier: notifier)
        let pages = ReminderPages(ReminderPages.Dependencies(
            reminders: reminders,
            appCopy: appCopy,
            serviceName: copy("common.service_name"),
            site: AppEnvironment.site,
            version: Self.version,
            open: { UIApplication.shared.open($0) }))
        let model = CardProofModel.ofThisBuild(copy: copy, appCopy: appCopy, reminders: reminders, pages: pages)
        notifier.snoozed = { [weak model] in await model?.snoozeReminder() }
        notifier.opened = { [weak model, weak pages] in
            pages?.close()
            model?.openedFromReminder()
        }
        self.notifier = notifier
        _model = StateObject(wrappedValue: model)
        _pages = StateObject(wrappedValue: pages)
    }

    /// The version the settings write: the store's date version; `dev` for
    /// the development build (design/copy/app.md, the settings).
    private static var version: String {
        AppEnvironment.storeBuild ? Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" : "dev"
    }

    var body: some Scene {
        WindowGroup {
            // Under the tests of Tests/, which run inside the app, the app
            // itself shows nothing and asks the test site for nothing: each
            // test makes its own model, against a back end of its own.
            if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
                Group {
                    if opening {
                        SplashView(appCopy: Copy.bundled("app"))
                    } else {
                        switch pages.pages.last {
                        case .schedule: ScheduleView(pages: pages)
                        case .settings: SettingsView(pages: pages)
                        case nil: CardProofView(model: model)
                        }
                    }
                }
                // The colors are design/tokens.json's, whatever the phone's appearance.
                .preferredColorScheme(.light)
                // Back from the system's settings, where notifications may have been allowed (step 7).
                .onChange(of: scenePhase) { phase in
                    if phase == .active { model.cameBack() }
                }
                .task {
                    // The server is asked for its config while the splash screen is up.
                    model.open()
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    withAnimation(.easeOut(duration: 0.2)) { opening = false }
                }
            }
        }
    }
}

extension CardProofModel {
    /// The card proof of this build: the site and the proof log of
    /// AppEnvironment, the core's own session (MOICA's keys), the files
    /// the app carries.
    static func ofThisBuild(copy: Copy, appCopy: Copy, reminders: Reminders, pages: ReminderPages) -> CardProofModel {
        let backend = HTTPBackend(site: AppEnvironment.site, publicFiles: AppEnvironment.publicFiles)
        let flow = CardProofFlow.Dependencies(
            proofLog: AppEnvironment.proofLog,
            backend: backend,
            card: NFCCard(copy: copy),
            clock: Date.init,
            crlNumbers: StoredCRLNumbers(),
            openSession: { try DeviceCore.Session(AppEnvironment.proofLog) },
            proofFiles: BundledFile.proofFiles(for:),
            counts: Counts.ofThisDevice(backend: backend))
        return CardProofModel(CardProofModel.Dependencies(
            flow: flow,
            copy: copy,
            appCopy: appCopy,
            reminders: reminders,
            openSchedule: { [weak pages] in pages?.openSchedule() },
            openNotificationSettings: openNotificationSettings,
            openSettings: { [weak pages] in pages?.openSettings() },
            site: AppEnvironment.site,
            open: { UIApplication.shared.open($0) },
            copyText: { UIPasteboard.general.string = $0 },
            share: share,
            canReadCards: { NFCCard.available },
            minApp: { config, now in MinApp.read(config: config, build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, now: now) },
            storePage: AppEnvironment.storePage))
    }

    /// The system's settings at this app's notifications; before iOS 16,
    /// at this app, where the notifications are one row.
    private static func openNotificationSettings() {
        let address: String
        if #available(iOS 16.0, *) {
            address = UIApplication.openNotificationSettingsURLString
        } else {
            address = UIApplication.openSettingsURLString
        }
        if let url = URL(string: address) { UIApplication.shared.open(url) }
    }

    /// The system's share sheet with `text`, over what the app shows.
    private static func share(_ text: String) {
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        var top = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        top?.present(sheet, animated: true)
    }
}

/// The words on every screen that are not the card proof's: each as
/// design/copy/ writes it (Tests/BuildTests.swift reads them there).
enum ScreenCopy {
    /// design/copy/test-site.md: the mark of the test log.
    static let testProofLog = "測試的證明紀錄"
}
