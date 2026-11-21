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

/// The words on the screen, each as design/copy/ writes it
/// (Tests/BuildTests.swift reads them there).
enum ScreenCopy {
    /// design/copy/test-site.md: the mark of the test roster.
    static let testRoster = "測試名冊"
}

/// The mark of the test roster, the two hosts this build talks to, then the
/// names of three functions of the core, each with the value it returned.
/// The names are identifiers of device-core/include/iamreal_device_core.h,
/// not sentences.
struct ShellView: View {
    @State private var report: CoreReport?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(ScreenCopy.testRoster).font(.headline)
            Text(AppEnvironment.site.host ?? "-").font(.body.monospaced())
            Text(AppEnvironment.publicFiles.host ?? "-").font(.body.monospaced())
            if let report {
                row("idc_abi_version", "\(report.abiVersion)")
                row("idc_self_check", "\(report.selfCheckFailure?.code ?? IDC_OK)")
                row("idc_scope_string", report.scopeString ?? "-")
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .task {
            report = await Task.detached(priority: .userInitiated) { CoreReport.make() }.value
        }
    }

    private func row(_ function: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(function).font(.caption.monospaced()).foregroundColor(.secondary)
            Text(value).font(.body.monospaced()).accessibilityIdentifier(function)
        }
    }
}
