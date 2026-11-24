import SwiftUI

/// What the app shows as it opens (design/screens/app-splash-phone.png):
/// the mark in the middle, and at the bottom the service's name and the
/// site's, a thin line between them (design/copy/app.md, the splash screen;
/// the line as the header of design/DESIGN.md draws it). Nothing to press.
struct SplashView: View {
    let appCopy: Copy

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Mark().frame(width: 112, height: 112)
            Spacer()
            HStack(spacing: 12) {
                Text(appCopy("splash.name"))
                    .font(Theme.display(Theme.sizeBody))
                    .foregroundColor(Theme.ink.color)
                Rectangle().fill(Theme.line.color).frame(width: 1, height: Theme.sizeBody.value)
                Text(appCopy("splash.site"))
                    .font(Theme.display(Theme.sizeKicker))
                    .foregroundColor(Theme.mute.color)
            }
            .accessibilityElement(children: .combine)
            .padding(.bottom, 56)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg.color.ignoresSafeArea())
    }
}
