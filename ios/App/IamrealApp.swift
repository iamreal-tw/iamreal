import SwiftUI

/// The shell of the iOS app (issue #168): it shows that device-core/ is
/// linked and answers. The card proof's screens replace ShellView.
@main
struct IamrealApp: App {
    var body: some Scene {
        WindowGroup {
            ShellView()
        }
    }
}

/// The words on the screen. Each is in design/copy/; the rest of the
/// screen is names of functions and the values they returned.
enum Copy {
    /// design/copy/test-site.md: the mark of the test roster.
    static let testRoster = "測試名冊"
}

struct ShellView: View {
    @State private var report: CoreReport?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Copy.testRoster).font(.headline)
            row("site", AppEnvironment.site.host ?? "")
            row("data", AppEnvironment.data.host ?? "")
            if let report {
                row("idc_abi_version", "\(report.abiVersion)" + (report.abiVersionMatches ? "" : " != \(DeviceCore.headerABIVersion)"))
                row("idc_self_check", "\(report.selfCheck)")
                row("idc_scope_string", report.scopeString ?? "-")
                row("bundled files", "\(report.bundledFiles)/\(report.bundledFilesExpected)")
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .task {
            report = await Task.detached(priority: .userInitiated) { CoreReport.make() }.value
        }
    }

    private func row(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).font(.caption.monospaced()).foregroundColor(.secondary)
            Text(value).font(.body.monospaced()).accessibilityIdentifier(name)
        }
    }
}
