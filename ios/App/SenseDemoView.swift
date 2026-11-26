import SwiftUI

/// The picture of step 2's demonstration (design/copy/card-proof.md, the
/// demonstrations; design/motion/README.md, on where the card goes): the
/// phone, its front to the cardholder, does not move; the card, red, comes
/// from the right and goes behind it, to the top of its back. What the
/// phone hides of the card shows through as a red dashed outline. A red
/// ring, once, where the phone reads it. No hand, no turning the phone, no
/// library: SwiftUI's own shapes, and the system's time for each frame.
///
/// What the picture is at a moment is TeachingAnimation's to say, from the
/// timeline the app carries; this view only draws that state. It plays
/// while CardProofModel says so (`demo.playing`): three rounds, then it
/// tells the model it has come to rest. Not playing, it is at rest with
/// the card in place once it has played, and the phone alone before. It
/// plays whatever the phone's setting to reduce motion (#369). To VoiceOver
/// the whole picture is one sentence.
struct SenseDemoView: View {
    let demo: SenseDemo
    let timeline: SenseTimeline
    var perform: (Action) -> Void
    /// The one moment to draw, in seconds, whatever plays: for pictures of it.
    var moment: Double?

    /// When this play started; nil while it does not play.
    @State private var started: Date?

    /// The platform whose rounds the demonstration shows.
    static let variant = "ios"
    /// The picture: this wide for its height.
    private static let aspect: CGFloat = 1.5
    /// A phone and a card, by their real sizes in millimetres: an iPhone
    /// about 71.5 by 147, a card 85.6 by 54 (ISO/IEC 7810, ID-1).
    private static let phone = CGSize(width: 71.5, height: 147)
    private static let card = CGSize(width: 85.6, height: 54)

    /// How long it plays before it rests.
    private var length: Double { (try? TeachingAnimation.senseLength(timeline, variant: Self.variant)) ?? 0 }

    var body: some View {
        Group {
            if let moment {
                picture(at: moment)
            } else if demo.playing, let started {
                // No more often than sixty moments a second, whatever the screen can show.
                TimelineView(.animation(minimumInterval: 1.0 / 60)) { context in picture(at: context.date.timeIntervalSince(started)) }
            } else {
                picture(at: demo.played ? length : 0)
            }
        }
        .aspectRatio(Self.aspect, contentMode: .fit)
        .background(Theme.soft.color)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusPanel.value))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(demo.description)
        .onAppear { follow(demo.playing) }
        .onChange(of: demo.playing) { follow($0) }
        .task(id: started) {
            // At rest after its rounds: the model is told, and its button says so.
            guard let started else { return }
            let left = length - Date().timeIntervalSince(started)
            if left > 0 { try? await Task.sleep(nanoseconds: UInt64(left * 1_000_000_000)) }
            if !Task.isCancelled { perform(.stopDemo) }
        }
    }

    /// The model says whether it plays; the time it started is kept here.
    private func follow(_ playing: Bool) {
        if playing {
            if started == nil { started = Date() }
        } else {
            started = nil
        }
    }

    private func picture(at seconds: Double) -> some View {
        // The app's timeline has the platform's rounds: a state is always there.
        let state = (try? TeachingAnimation.senseState(timeline, variant: Self.variant, at: seconds))
            ?? SenseState(round: 1, stopped: false, card: SenseState.Card(y: 0, x: timeline.enter.from, opacity: 0), ring: nil)
        return GeometryReader { geometry in
            let size = geometry.size
            // The phone stands in the middle, a little to the left: the card comes from the right.
            let height = size.height * 0.86
            let unit = height / Self.phone.height
            let phone = CGRect(
                x: size.width * 0.42 - Self.phone.width * unit / 2, y: (size.height - height) / 2,
                width: Self.phone.width * unit, height: height)
            let cardSize = CGSize(width: Self.card.width * unit, height: Self.card.height * unit)
            // The card's centre: `y` down the phone, `x` phone widths to the right of the phone's middle.
            let centre = CGPoint(x: phone.midX + CGFloat(state.card.x) * phone.width, y: phone.minY + CGFloat(state.card.y) * phone.height)
            let body = RoundedRectangle(cornerRadius: phone.width * 0.16)
            let cardShape = RoundedRectangle(cornerRadius: cardSize.height * 0.08)
            ZStack {
                // The card, behind the phone.
                cardShape.fill(Theme.you.color)
                    .frame(width: cardSize.width, height: cardSize.height)
                    .position(centre)
                    .opacity(state.card.opacity)
                // The phone, its front to the cardholder: the screen, and the camera's island at its top.
                body.fill(Theme.bg.color)
                    .overlay(body.stroke(Theme.ink.color, lineWidth: 2))
                    .overlay(
                        RoundedRectangle(cornerRadius: phone.width * 0.11).fill(Theme.soft.color).padding(phone.width * 0.045))
                    .overlay(alignment: .top) {
                        Capsule().fill(Theme.ink.color)
                            .frame(width: phone.width * 0.3, height: phone.width * 0.085)
                            .padding(.top, phone.width * 0.085)
                    }
                    .frame(width: phone.width, height: phone.height)
                    .position(x: phone.midX, y: phone.midY)
                // What the phone hides of the card: its outline, dashed, only over the phone.
                cardShape.stroke(Theme.you.color, style: StrokeStyle(lineWidth: 2, dash: [5, 4]))
                    .frame(width: cardSize.width, height: cardSize.height)
                    .position(centre)
                    .opacity(state.card.opacity)
                    .mask(body.frame(width: phone.width, height: phone.height).position(x: phone.midX, y: phone.midY))
                // The phone reads it: a ring about the card's centre.
                Circle().stroke(Theme.you.color, lineWidth: 3)
                    .frame(width: phone.width * 0.5, height: phone.width * 0.5)
                    .scaleEffect(CGFloat(state.ring?.scale ?? timeline.ring.from))
                    .opacity(state.ring?.opacity ?? 0)
                    .position(centre)
            }
        }
    }
}
