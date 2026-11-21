import SwiftUI
import UIKit
@testable import IamrealApp

/// Pictures of the screens as the app draws them, for people to look at:
/// CardProofView with a test's model, in the app's own window, written as
/// PNG files next to the back end's files (web/test-output/app/screens-ios).
@MainActor
enum Snapshot {
    private static var window: UIWindow?

    static func save(_ model: CardProofModel, as name: String) async {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let window = self.window ?? UIWindow(windowScene: scene)
        self.window = window
        window.rootViewController = UIHostingController(rootView: CardProofView(model: model))
        window.makeKeyAndVisible()
        // One turn of the run loop, for SwiftUI to lay the screen out.
        try? await Task.sleep(nanoseconds: 300_000_000)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let directory = Repository.root.appendingPathComponent("web/test-output/app/screens-ios")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? image.pngData()?.write(to: directory.appendingPathComponent("\(name).png"))
    }
}
