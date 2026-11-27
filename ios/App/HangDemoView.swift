import SwiftUI
import UIKit

/// The picture of step 6's demonstration (design/copy/card-proof.md, the
/// demonstrations; design/motion/README.md): five screens side by side, the
/// app's own and four sketches of Threads drawn after
/// design/copy/hang.md's, and a camera that goes over them. No library: the
/// screens are SwiftUI's own views, and the system gives the time of each
/// frame (TimelineView).
///
/// What the picture is at a moment is TeachingAnimation's to say, from the
/// timeline the app carries; this view only draws that state. The boxes the
/// timeline names report where they were laid out, and the camera is aimed
/// by those places, so no coordinate is written here.
///
/// When most of it has come onto the screen it says so (`.showDemo`), and
/// CardProofModel plays it, once in a card proof; then it plays when its
/// button says so. Whether it plays and whether it has played are the
/// model's (`demo.playing`, `demo.played`): not playing, it is its first
/// frame before it ever played and its last frame after. It plays whatever the phone's setting to reduce motion: the
/// button beside it stops it (#369). To VoiceOver the whole picture is one
/// sentence.
struct HangDemoView: View {
    let demo: HangDemo
    let timeline: HangTimeline
    var perform: (Action) -> Void
    /// Which of the written steps the demonstration is at, 1 to 4; 0 when at none.
    @Binding var step: Int
    /// The one moment to draw, in seconds, whatever plays: for pictures of it.
    var moment: Double?

    /// When this play started; nil while it does not play.
    @State private var started: Date?
    /// It has said that it came onto the screen.
    @State private var seen = false
    /// Where each named box was laid out, in the row of screens.
    @State private var places: [String: CGRect] = [:]

    private static let row = "hang-demo-row"
    /// The platform whose way back the demonstration shows.
    static let variant = "ios"
    /// How much of the picture is on the screen when it starts.
    private static let most: CGFloat = 0.6

    var body: some View {
        Group {
            if let moment {
                picture(at: moment)
            } else if demo.playing, let started {
                // No more often than the timeline's sixty moments a second, whatever the screen can show.
                TimelineView(.animation(minimumInterval: 1.0 / 60)) { context in picture(at: context.date.timeIntervalSince(started)) }
            } else {
                picture(at: demo.played ? timeline.duration : 0)
            }
        }
        .aspectRatio(timeline.picture.width / timeline.picture.height, contentMode: .fit)
        .background(Theme.soft.color)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusPanel.value))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(demo.description)
        .background(GeometryReader { geometry in
            Color.clear.preference(key: OnScreen.self, value: geometry.frame(in: .global))
        })
        .onPreferenceChange(OnScreen.self) { frame in
            guard moment == nil, !seen, frame.height > 0 else { return }
            let screen = UIScreen.main.bounds
            let visible = frame.intersection(screen).height
            // Most of the picture, or on a screen lower than the picture, most of the screen.
            guard visible >= Self.most * frame.height || visible >= Self.most * screen.height else { return }
            seen = true
            perform(.showDemo)
        }
        .onAppear { follow(demo.playing) }
        .onChange(of: demo.playing) { follow($0) }
        .task(id: started) { await keepTime() }
    }

    /// The model says whether it plays; the time it started is kept here.
    private func follow(_ playing: Bool) {
        if playing {
            if started == nil { started = Date() }
        } else {
            started = nil
            step = 0
        }
    }

    /// While it plays: the written step it is at, as each comes; and at the end, that it has stopped.
    private func keepTime() async {
        guard let started else { return }
        func wait(until seconds: Double) async -> Bool {
            let left = seconds - Date().timeIntervalSince(started)
            if left > 0 { try? await Task.sleep(nanoseconds: UInt64(left * 1_000_000_000)) }
            return !Task.isCancelled
        }
        for event in timeline.events where event.do == "step" {
            guard await wait(until: event.at) else { return }
            // The two buttons (0) and the result (5) are none of the four steps.
            step = (1...4).contains(event.step ?? 0) ? event.step ?? 0 : 0
        }
        guard await wait(until: timeline.duration) else { return }
        perform(.stopDemo)
    }

    // The camera ---------------------------------------------------------------------

    private struct Pose {
        var scale: CGFloat = 1
        var x: CGFloat = 0
        var y: CGFloat = 0
    }

    /// A framing as the row's scale and place in a picture of `size`
    /// (design/motion/README.md, on framings); nil until its boxes have reported where they are.
    private func pose(_ name: String, in size: CGSize) -> Pose? {
        guard let frame = timeline.frames[name], let x = places[frame.x.t], let y = places[frame.y.t] else { return nil }
        // A screen is drawn as many points wide as the timeline has units to a screen (`width`).
        let scale = size.width / (CGFloat(frame.span) * width / CGFloat(timeline.screen))
        return Pose(
            scale: scale,
            x: size.width * CGFloat(frame.x.v) - scale * (x.minX + x.width * CGFloat(frame.x.a)),
            y: size.height * CGFloat(frame.y.v) - scale * (y.minY + y.height * CGFloat(frame.y.a)))
    }

    private func pose(_ camera: HangState.Camera, in size: CGSize) -> Pose {
        guard let from = pose(camera.from, in: size), let to = pose(camera.to, in: size) else { return Pose() }
        let p = CGFloat(camera.progress)
        return Pose(scale: from.scale + (to.scale - from.scale) * p, x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p)
    }

    private func picture(at seconds: Double) -> some View {
        // The app's timeline has the platform's names: a state is always there.
        let state = (try? TeachingAnimation.hangState(timeline, variant: Self.variant, at: seconds))
            ?? HangState(camera: HangState.Camera(from: timeline.start, to: timeline.start, progress: 1))
        return GeometryReader { geometry in
            let aim = pose(state.camera, in: geometry.size)
            screens(state)
                .fixedSize()
                .coordinateSpace(name: Self.row)
                .onPreferenceChange(Places.self) { places = $0 }
                .scaleEffect(aim.scale, anchor: .topLeading)
                .offset(x: aim.x, y: aim.y)
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
    }

    // The five screens -----------------------------------------------------------------

    /// How wide one screen is drawn, in points: the timeline's unit.
    private var width: CGFloat { CGFloat(timeline.screen) }

    private func screens(_ state: HangState) -> some View {
        HStack(alignment: .top, spacing: 120) {
            own(state)
            profile(state)
            editing(state)
            links(state)
            adding(state)
        }
        .padding(60)
    }

    /// The boxes of design/motion/hang.json this picture draws, by the
    /// names the timeline calls them: the five screens and what is
    /// pressed, framed or aimed at on them. What an iPhone does not have
    /// is not here: the ✕ an Android goes back by (`x3`).
    enum Name: String, CaseIterable {
        case s0, copy, open
        case s1, edit, linkrow
        case s2, links
        case s3, add, done3
        case s4, urlfield, paste, done4
    }

    private func box(_ name: Name, _ state: HangState) -> Box {
        Box(name: name.rawValue, state: state, press: timeline.tap.press, ringFrom: timeline.tap.from)
    }

    /// One screen: its card. No small words above it, and none beside what
    /// is pressed: the demonstration goes by too fast to read them
    /// (design/copy/card-proof.md, the section on the demonstrations).
    private func shot<Content: View>(_ name: Name, _ state: HangState, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14, content: content)
            .padding(18)
            .frame(width: width, alignment: .leading)
            .background(Theme.bg.color)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line.color, lineWidth: 1))
            .modifier(box(name, state))
    }

    /// What the sketch does not write: a grey bar.
    private func blank(_ width: CGFloat, _ height: CGFloat = 10) -> some View {
        RoundedRectangle(cornerRadius: 4).fill(Theme.line.color).frame(width: width, height: height)
    }

    private func bold(_ text: String, _ size: CGFloat = 16) -> some View {
        Text(text).font(.system(size: size, weight: .bold)).foregroundColor(Theme.ink.color).lineLimit(1)
    }

    /// The app's own screen: this step's title, the link, the two buttons.
    private func own(_ state: HangState) -> some View {
        let copied = state.states["copied"] ?? 0
        return shot(.s0, state) {
            Text(demo.words.title).font(.system(size: 20, weight: .bold)).foregroundColor(Theme.ink.color)
                .fixedSize(horizontal: false, vertical: true)
            Text(demo.link).font(.system(size: 13, design: .monospaced)).foregroundColor(Theme.ink.color).lineLimit(1)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.soft.color)
            HStack(spacing: 8) {
                ZStack {
                    Text(demo.words.copy).opacity(1 - copied)
                    Text(demo.words.copied).opacity(copied)
                }
                .font(.system(size: 14, weight: .bold)).foregroundColor(Theme.bg.color).lineLimit(1)
                .padding(.horizontal, 12)
                .frame(height: 44)
                .background(Theme.you.color)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .modifier(box(.copy, state))
                Text(demo.words.open).font(.system(size: 14, weight: .bold)).foregroundColor(Theme.ink.color)
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.ink.color, lineWidth: 1.5))
                    .modifier(box(.open, state))
            }
            VStack(alignment: .leading, spacing: 10) {
                blank(280)
                blank(300)
                blank(240)
                blank(180)
            }
            .padding(.top, 6)
        }
    }

    /// The profile on Threads: the account, and once the link is hung, its line.
    private func profile(_ state: HangState) -> some View {
        let hung = CGFloat(state.states["linkOnProfile"] ?? 0)
        let labelled = CGFloat(state.states["resultLabel"] ?? 0)
        return shot(.s1, state) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    blank(120, 14)
                    Text(demo.account).font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.ink.color)
                        .lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 12)
                Circle().fill(Theme.line.color).frame(width: 56, height: 56)
            }
            VStack(alignment: .leading, spacing: 10) {
                blank(260)
                blank(200)
            }
            // The line of the link takes its room as it comes, and what is under it moves down; then its label.
            HStack(spacing: 6) {
                Image(systemName: "link").font(.system(size: 12, weight: .bold)).foregroundColor(Theme.ink.color)
                Text(demo.link).font(.system(size: 14, weight: .bold)).foregroundColor(Theme.ink.color)
                    .lineLimit(1).truncationMode(.tail)
            }
            .frame(height: 24)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.ink.color, lineWidth: 2).padding(-5).opacity(labelled))
            .overlay(alignment: .bottomLeading) {
                Text(demo.words.found).font(.system(size: 12, weight: .bold)).foregroundColor(Theme.bg.color).lineLimit(1)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Theme.ink.color)
                    .fixedSize()
                    .alignmentGuide(.bottom) { $0[.top] - 10 }
                    .opacity(labelled)
            }
            .modifier(box(.linkrow, state))
            .opacity(hung)
            .frame(height: 24 * hung + 40 * labelled, alignment: .top)
            .padding(.top, -14 * (1 - hung))
            blank(90)
            HStack(spacing: 8) {
                Text(demo.words.edit).font(.system(size: 14, weight: .bold)).foregroundColor(Theme.ink.color).lineLimit(1)
                    .frame(maxWidth: .infinity)
                    .frame(height: 38)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line.color, lineWidth: 1))
                    .modifier(box(.edit, state))
                blank(60)
                    .frame(maxWidth: .infinity)
                    .frame(height: 38)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line.color, lineWidth: 1))
            }
            // Room for the tag under the button.
            .padding(.bottom, 30)
        }
    }

    /// A row of a list: its name, and a grey bar for its value.
    private func row(_ name: String) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(name).font(.system(size: 15)).foregroundColor(Theme.ink.color).lineLimit(1)
                Spacer()
                blank(90)
            }
            .frame(height: 46)
            Divider().overlay(Theme.line.color)
        }
    }

    /// Editing the profile: the list, of which the links are pressed.
    private func editing(_ state: HangState) -> some View {
        shot(.s2, state) {
            bold(demo.words.edit)
            VStack(spacing: 0) {
                ForEach(Array(demo.words.rows.enumerated()), id: \.offset) { _, name in row(name) }
                HStack {
                    Text(demo.words.links).font(.system(size: 15)).foregroundColor(Theme.ink.color).lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.mute.color)
                }
                .frame(height: 46)
                .modifier(box(.links, state))
                // Room for the tag under the row.
                .padding(.bottom, 30)
                Divider().overlay(Theme.line.color)
                row(demo.words.featured)
            }
        }
    }

    /// The links: the row that adds one, and once one was added, it above that row.
    private func links(_ state: HangState) -> some View {
        let listed = CGFloat(state.states["linkListed"] ?? 0)
        return shot(.s3, state) {
            HStack {
                bold(demo.words.links)
                Spacer()
                bold(demo.words.done, 15).modifier(box(.done3, state))
            }
            // Room for the tag under what is at the top right.
            .padding(.bottom, 26)
            VStack(spacing: 0) {
                Text(demo.link).font(.system(size: 15)).foregroundColor(Theme.ink.color).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 46 * listed, alignment: .center)
                    .opacity(listed)
                Divider().overlay(Theme.line.color).opacity(listed)
                Text(demo.words.add).font(.system(size: 15)).foregroundColor(Theme.ink.color).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 46)
                    .modifier(box(.add, state))
            }
            .padding(.bottom, 30)
        }
    }

    /// Adding a link: the field the address is pasted in, then what is at the top right.
    private func adding(_ state: HangState) -> some View {
        let menu = state.states["pasteMenu"] ?? 0
        let pasted = state.states["pasted"] ?? 0
        return shot(.s4, state) {
            HStack {
                bold(demo.words.add)
                Spacer()
                bold(demo.words.done, 15).modifier(box(.done4, state))
            }
            // Room for the tag under what is at the top right, and for the paste bubble over the field.
            .padding(.bottom, 34)
            VStack(alignment: .leading, spacing: 6) {
                Text(demo.words.url).font(.system(size: 12)).foregroundColor(Theme.mute.color).lineLimit(1)
                Text(demo.address).font(.system(size: 14)).foregroundColor(Theme.ink.color).lineLimit(1).truncationMode(.tail)
                    .opacity(pasted)
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 44)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line.color, lineWidth: 1))
                    .overlay(alignment: .topLeading) {
                        // The bubble is there between the long press and the paste; the ring of pressing it stays where it was.
                        Text(demo.words.paste).font(.system(size: 13, weight: .bold)).foregroundColor(Theme.bg.color).lineLimit(1)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Theme.ink.color)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .opacity(menu * (1 - pasted))
                            .fixedSize()
                            .modifier(box(.paste, state))
                            .alignmentGuide(.top) { $0[.bottom] + 6 }
                            .padding(.leading, 12)
                    }
                    .modifier(box(.urlfield, state))
            }
            // Room for the tag under the field.
            .padding(.bottom, 26)
            VStack(alignment: .leading, spacing: 6) {
                Text(demo.words.linkTitle).font(.system(size: 12)).foregroundColor(Theme.mute.color).lineLimit(1)
                RoundedRectangle(cornerRadius: 6).stroke(Theme.line.color, lineWidth: 1).frame(height: 44)
            }
        }
    }

    // A box the timeline names ----------------------------------------------------------

    /// What the timeline can do to a named box: frame it (a mark), darken
    /// it and ring it (a tap). It reports where it was laid
    /// out, for the camera.
    private struct Box: ViewModifier {
        let name: String
        let state: HangState
        /// How dark the ink over a box pressed all the way is.
        let press: Double
        /// The size of the ring before a tap starts.
        let ringFrom: Double

        func body(content: Content) -> some View {
            let mark = state.marks[name] ?? 0
            let tap = state.tap?.target == name ? state.tap : nil
            return content
                .overlay(Theme.ink.color.opacity((tap?.pressed ?? 0) * press).clipShape(RoundedRectangle(cornerRadius: 4)))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.you.color, lineWidth: 2).padding(-5).opacity(mark))
                // The ring, about the middle of the box: out of sight between taps.
                .overlay(
                    Circle().stroke(Theme.you.color, lineWidth: 3)
                        .frame(width: 48, height: 48)
                        .scaleEffect(CGFloat(tap?.ring.scale ?? ringFrom))
                        .opacity(tap?.ring.opacity ?? 0))
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: Places.self, value: [name: geometry.frame(in: .named(HangDemoView.row))])
                })
        }
    }

    /// Where each named box was laid out: every box adds its own.
    private struct Places: PreferenceKey {
        static var defaultValue: [String: CGRect] = [:]
        static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
            value.merge(nextValue()) { _, new in new }
        }
    }

    /// Where the picture is on the phone's screen.
    private struct OnScreen: PreferenceKey {
        static var defaultValue = CGRect.zero
        static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
    }
}
