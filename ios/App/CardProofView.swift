import SwiftUI

/// The card proof as the app shows it: the model's screen, drawn by
/// ScreenView, with what its buttons and fields do.
struct CardProofView: View {
    @ObservedObject var model: CardProofModel

    var body: some View {
        ScreenView(
            screen: model.screen,
            copy: model.copy,
            pinText: $model.pinText,
            perform: model.perform,
            type: model.type)
            .task { model.open() }
    }
}

/// Draws a Screen after design/screens/card-proof-app-*: the mark of the
/// test log, the mark and the name of the service, which step it is, the
/// blocks from top to bottom, the buttons. It has no sentence and no
/// decision of its own; what a button does is `perform`'s.
///
/// The values are design/tokens.json's (Theme); white, ink, and the
/// cardholder's red for the way on. No green, no tick outside the two
/// progress lists, no illustration (design/DESIGN.md).
struct ScreenView: View {
    let screen: Screen
    let copy: Copy
    @Binding var pinText: String
    var perform: (Action) -> Void
    /// What the cardholder typed in the field of a platform.
    var type: (String, String) -> Void
    /// The whole screen, not scrolled: for pictures of it.
    var unscrolled = false
    /// Drawn again when the phone's text size changes (Theme's sizes follow it).
    @Environment(\.sizeCategory) private var sizeCategory
    /// Which of step 6's written steps its demonstration is at, 1 to 4; 0 when at none.
    @State private var demoStep = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            if unscrolled {
                content
                Spacer(minLength: 0)
            } else {
                ScrollView { content }
            }
        }
        .background(Theme.bg.color.ignoresSafeArea())
        .foregroundColor(Theme.text.color)
        .environment(\.colorScheme, .light)
    }

    private var header: some View {
        AppHeader(name: copy("common.service_name"), link: screen.settings.map { button in (button.label, { perform(button.action) }) })
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let notice = screen.notice { self.notice(notice) }
            stepBars
            ForEach(Array(screen.blocks.enumerated()), id: \.offset) { index, block in
                self.block(block, first: index == 0)
            }
            if !screen.buttons.isEmpty {
                VStack(spacing: 12) {
                    // The way on, the last of them, on top.
                    ForEach(Array(screen.buttons.enumerated().reversed()), id: \.offset) { index, button in
                        self.button(button, main: screen.mainButton && index == screen.buttons.count - 1)
                    }
                }
                .padding(.top, 36)
            }
            // The ways back, as links: to the screen before, then out of the card proof.
            ForEach(Array((screen.links + [screen.cancel].compactMap { $0 }).enumerated()), id: \.offset) { index, link in
                SwiftUI.Button { perform(link.action) } label: {
                    Text(link.label)
                        .font(Theme.body(Theme.sizeKicker))
                        .underline()
                        .foregroundColor(Theme.text.color)
                        .frame(minHeight: Theme.minTarget.value)
                }
                .padding(.top, index == 0 ? 16 : 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.gutter.value)
        .padding(.top, 24)
        .padding(.bottom, 48)
    }

    /// The box above the step: the note of the reminder the app was opened from.
    private func notice(_ notice: Notice) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(notice.text).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.ink.color)
                .lineSpacing(Theme.spacing(Theme.leadingSmall, Theme.sizeKicker))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let button = notice.button { self.button(button, main: false) }
        }
        .padding(16)
        .background(Theme.soft.color)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusPanel.value))
        .padding(.bottom, 24)
    }

    /// Which of the eight steps: the line, then a bar for each, those done in ink.
    private var stepBars: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(copy("common.step", ["step": String(screen.step), "steps": String(Screens.steps)]))
                .font(Theme.body(Theme.sizeKicker))
                .lineSpacing(Theme.spacing(Theme.leadingKicker, Theme.sizeKicker))
                .foregroundColor(Theme.mute.color)
            HStack(spacing: 6) {
                ForEach(1...Screens.steps, id: \.self) { step in
                    Rectangle()
                        .fill(step <= screen.step ? Theme.ink.color : Theme.line.color)
                        .frame(height: 4)
                }
            }
            .accessibilityHidden(true)
        }
    }

    // The words ------------------------------------------------------------------------

    private func paragraph(_ text: String) -> some View {
        Text(text)
            .font(Theme.body(Theme.sizeBody))
            .lineSpacing(Theme.spacing(Theme.leadingBody, Theme.sizeBody))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func small(_ text: String, color: RGB = Theme.mute) -> some View {
        Text(text)
            .font(Theme.body(Theme.sizeSmall))
            .lineSpacing(Theme.spacing(Theme.leadingSmall, Theme.sizeSmall))
            .foregroundColor(color.color)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func display(_ text: String, _ size: Length, _ leading: Number) -> some View {
        Text(text)
            .font(Theme.display(size))
            .lineSpacing(Theme.spacing(leading, size))
            .foregroundColor(Theme.ink.color)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func block(_ block: Block, first: Bool) -> some View {
        switch block {
        case .title(let text):
            display(text, Theme.sizeTitle, Theme.leadingTitle).padding(.top, first ? 28 : 20)
        case .heading(let text):
            display(text, Theme.sizeTitle, Theme.leadingTitle).padding(.top, 40)
        case .subheading(let text):
            Text(text).font(Theme.body(Theme.sizeBody, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 20)
        case .text(let text):
            paragraph(text).padding(.top, 12)
        case .sentences(let sentences):
            paragraph(sentences.joined()).padding(.top, 12)
        case .declared(let account):
            Text(account).font(Theme.body(Theme.sizeHeading, Theme.weightAccount)).foregroundColor(Theme.ink.color)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
        case .strong(let text):
            Text(text).font(Theme.body(Theme.sizeBody, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                .lineSpacing(Theme.spacing(Theme.leadingBody, Theme.sizeBody))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 12)
        case .lead(let text):
            display(text, Theme.sizeLead, Theme.leadingHeading).padding(.top, 28)
        case .small(let text):
            small(text).padding(.top, 12)
        case .kicker(let text):
            VStack(alignment: .leading, spacing: 16) {
                Divider().overlay(Theme.line.color)
                Text(text).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.mute.color)
                    .lineSpacing(Theme.spacing(Theme.leadingKicker, Theme.sizeKicker))
            }
            .padding(.top, 40)
        case .proofCard(let card):
            proofCard(card).frame(maxWidth: 260).padding(.top, 24)
        case .steps(let steps):
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    // The step the demonstration is at: on soft grey, a red line at its left (design/copy/hang.md).
                    let now = index + 1 == demoStep
                    HStack(alignment: .firstTextBaseline, spacing: 14) {
                        Text(verbatim: String(index + 1)).font(Theme.display(Theme.sizeHeading)).foregroundColor(Theme.ink.color)
                        Text(step).font(Theme.body(Theme.sizeBody, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 6).padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(now ? Theme.soft.color : Theme.bg.color)
                    .overlay(alignment: .leading) { Rectangle().fill(now ? Theme.you.color : Theme.bg.color).frame(width: 3) }
                    .padding(.horizontal, -10)
                }
            }
            .padding(.top, 20)
        case .linked(let before, let link, let after):
            SwiftUI.Button { perform(link.action) } label: {
                (Text(before) + Text(link.label).underline() + Text(after))
                    .font(Theme.body(Theme.sizeBody, Theme.weightHeading))
                    .foregroundColor(Theme.you.color)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: Theme.minTarget.value, alignment: .leading)
            }
            .padding(.top, 28)
        case .points(let points, let bold):
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                    HStack(alignment: .firstTextBaseline, spacing: 14) {
                        Circle().fill(Theme.ink.color).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
                        Self.emphasised(point, bold).font(Theme.body(Theme.sizeBody))
                            .lineSpacing(Theme.spacing(Theme.leadingBody, Theme.sizeBody) * 0.8)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.top, 28)
        case .question(let question, let answer):
            VStack(spacing: 0) {
                Divider().overlay(Theme.line.color)
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 8) {
                        // An answer holds a paragraph, a button or a link: drawn as on the screen itself.
                        ForEach(Array(answer.enumerated()), id: \.offset) { _, part in AnyView(self.block(part, first: false)) }
                    }
                    .padding(.bottom, 12)
                } label: {
                    Text(question).font(Theme.body(Theme.sizeBody, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                        .frame(maxWidth: .infinity, minHeight: Theme.buttonHeight.value, alignment: .leading)
                }
                .accentColor(Theme.ink.color)
                Divider().overlay(Theme.line.color)
            }
            .padding(.top, 8)
        case .items(let items):
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Divider().overlay(Theme.line.color)
                    self.item(item)
                }
                Divider().overlay(Theme.line.color)
            }
            .padding(.top, 24)
        case .cardName(let label, let name, let note):
            VStack(alignment: .leading, spacing: 6) {
                Text(label).font(Theme.body(Theme.sizeSmall)).foregroundColor(Theme.mute.color)
                // The system's typeface, not the headings': that one is a subset of the words of design/copy/, and a name has others (design/DESIGN.md, "字").
                Text(name).font(Theme.body(Theme.sizeHeading, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                Text(note).font(Theme.body(Theme.sizeSmall)).foregroundColor(Theme.mute.color)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.soft.color)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusPanel.value))
            .padding(.top, 24)
        case .pinField(let label):
            VStack(alignment: .leading, spacing: 10) {
                Text(label).font(Theme.body(Theme.sizeBody, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                // No content type: the system is not to offer to fill the PIN in, or to save it.
                SecureField("", text: $pinText)
                    .keyboardType(.asciiCapable)
                    .font(Theme.body(Theme.sizeBody))
                    .padding(.horizontal, 16)
                    .frame(height: Theme.buttonHeight.value)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radius.value).stroke(Theme.ink.color, lineWidth: 1))
                    .accessibilityLabel(label)
            }
            .padding(.top, 28)
        case .message(let text):
            Text(text).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.ink.color)
                .lineSpacing(Theme.spacing(Theme.leadingSmall, Theme.sizeKicker))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.soft.color)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius.value))
                .padding(.top, 16)
        case .account(let row):
            account(row).padding(.top, 24)
        case .row(let name, let account, let lines):
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(name).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.mute.color).frame(width: 80, alignment: .leading)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(account).font(Theme.body(Theme.sizeBody, Theme.weightAccount)).foregroundColor(Theme.ink.color)
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in small(line, color: Theme.text) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 14)
                Divider().overlay(Theme.line.color)
            }
            .padding(.top, first ? 0 : 4)
        case .pair(let label, let value):
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(label).font(Theme.body(Theme.sizeKicker)).foregroundColor(Theme.mute.color).frame(width: 80, alignment: .leading)
                    Text(value).font(Theme.mono(Theme.sizeBody)).foregroundColor(Theme.ink.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 14)
                Divider().overlay(Theme.line.color)
            }
        case .link(let text):
            Text(text).font(Theme.mono(Theme.sizeKicker)).foregroundColor(Theme.ink.color).textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.soft.color)
                .padding(.top, 20)
        case .button(let button, let main):
            self.button(button, main: main).padding(.top, 12)
        case .sideBySide(let buttons):
            sideBySide(buttons).padding(.top, 12)
        case .demo(let demo):
            // Without the timeline there is no picture; the written steps under it say the same.
            if let timeline = HangTimeline.bundled {
                VStack(spacing: 12) {
                    HangDemoView(demo: demo, timeline: timeline, perform: perform, step: $demoStep)
                    self.button(demo.control, main: false)
                }
                .padding(.top, 24)
            }
        case .action(let button):
            SwiftUI.Button { perform(button.action) } label: {
                Text(button.label).font(Theme.body(Theme.sizeBody)).underline().foregroundColor(Theme.you.color)
                    .frame(minHeight: Theme.minTarget.value, alignment: .leading)
            }
            .padding(.top, 4)
        case .busy(let text):
            HStack(spacing: 10) {
                ProgressView()
                Text(text).font(Theme.body(Theme.sizeKicker))
            }
            .padding(.top, 16)
        case .figure(let figure):
            CardFigure(figure: figure).padding(.top, 22)
        }
    }

    /// `text` with the words `bold` among it in ink and bold.
    private static func emphasised(_ text: String, _ bold: String?) -> Text {
        guard let bold, let range = text.range(of: bold) else { return Text(text) }
        return Text(text[..<range.lowerBound])
            + Text(bold).fontWeight(Font.Weight(css: Theme.weightHeading.value)).foregroundColor(Theme.ink.color)
            + Text(text[range.upperBound...])
    }

    // The parts -----------------------------------------------------------------------

    /// A button as wide as the screen (design/DESIGN.md, the components):
    /// the main one red with white words, the others framed in ink.
    private func button(_ button: Button, main: Bool, oneLine: Bool = false) -> some View {
        SwiftUI.Button { perform(button.action) } label: {
            Text(button.label)
                .font(Theme.body(Theme.sizeBody, Theme.weightHeading))
                .lineLimit(oneLine ? 1 : nil)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: Theme.buttonHeight.value)
                .padding(.horizontal, 12)
        }
        .buttonStyle(Framed(main: main))
        .accessibilityLabel(button.spoken ?? button.label)
        .disabled(!button.enabled)
        .opacity(button.enabled ? 1 : 0.45)
    }

    /// Buttons side by side, the first the main one, each on one line;
    /// one under the other where that does not fit (a long account, large
    /// text). Before iOS 16 the system cannot be asked which fits: one
    /// under the other.
    @ViewBuilder
    private func sideBySide(_ buttons: [Button]) -> some View {
        let column = VStack(spacing: 12) {
            ForEach(Array(buttons.enumerated()), id: \.offset) { index, button in self.button(button, main: index == 0) }
        }
        if #available(iOS 16.0, *) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    ForEach(Array(buttons.enumerated()), id: \.offset) { index, button in self.button(button, main: index == 0, oneLine: true) }
                }
                column
            }
        } else {
            column
        }
    }

    /// The main button red with white words, darker while pressed; the
    /// others framed in ink.
    private struct Framed: ButtonStyle {
        let main: Bool

        func makeBody(configuration: Configuration) -> some View {
            let fill = main ? (configuration.isPressed ? Theme.youHover : Theme.you) : Theme.bg
            return configuration.label
                .foregroundColor(main ? Theme.bg.color : Theme.ink.color)
                .background(fill.color)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius.value).stroke(main ? fill.color : Theme.ink.color, lineWidth: 1.5))
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius.value))
        }
    }

    /// One item of a progress list: done in ink with a tick, in progress
    /// with a spinner, the rest an empty circle; its status at the end.
    private func item(_ item: Item) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Group {
                switch item.state {
                case .done: Image(systemName: "checkmark").font(.system(size: 15, weight: .bold)).foregroundColor(Theme.ink.color)
                case .working: ProgressView().scaleEffect(0.8)
                case .pending, .halted: Circle().stroke(Theme.line.color, lineWidth: 1.5).frame(width: 18, height: 18)
                }
            }
            .frame(width: 22)
            VStack(alignment: .leading, spacing: 6) {
                Text(item.label).font(Theme.body(Theme.sizeBody))
                    .foregroundColor(item.state == .pending ? Theme.mute.color : Theme.text.color)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array(item.why.enumerated()), id: \.offset) { _, line in
                    Text(line).font(Theme.body(Theme.sizeKicker, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !item.status.isEmpty {
                Text(item.status)
                    .font(Theme.body(Theme.sizeKicker, item.state == .done ? Theme.weightBody : Theme.weightHeading))
                    .foregroundColor(item.state == .done ? Theme.mute.color : Theme.ink.color)
            }
        }
        .padding(.vertical, 14)
    }

    private func account(_ row: AccountRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider().overlay(Theme.line.color)
            Text(row.name).font(Theme.body(Theme.sizeBody, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                .padding(.top, 10)
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Text(row.prefix).font(Theme.body(Theme.sizeBody)).foregroundColor(Theme.mute.color)
                    TextField("", text: Binding(get: { row.text }, set: { type($0, row.platform) }))
                        .font(Theme.body(Theme.sizeBody))
                        .foregroundColor(Theme.ink.color)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                        .keyboardType(.asciiCapable)
                        .accessibilityLabel(row.name)
                }
                .padding(.horizontal, 14)
                .frame(height: Theme.buttonHeight.value)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius.value).stroke(Theme.ink.color, lineWidth: 1))
                if let preview = row.preview {
                    SwiftUI.Button { perform(preview.action) } label: {
                        Text(preview.label)
                            .font(Theme.body(Theme.sizeKicker, Theme.weightHeading))
                            .foregroundColor(Theme.ink.color)
                            .padding(.horizontal, 14)
                            .frame(height: Theme.buttonHeight.value)
                            .overlay(RoundedRectangle(cornerRadius: Theme.radius.value).stroke(Theme.ink.color, lineWidth: 1.5))
                    }
                }
            }
            ForEach(Array(row.lines.enumerated()), id: \.offset) { _, line in small(line) }
            if let error = row.error {
                Text(error).font(Theme.body(Theme.sizeKicker, Theme.weightHeading)).foregroundColor(Theme.ink.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The small card (design/DESIGN.md, the components: the proof card):
    /// white, framed in ink, the account the largest, never red but for the mark.
    private func proofCard(_ card: ProofCard) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Mark(animated: true).frame(width: 18, height: 18)
                Text(card.label).font(Theme.body(Theme.sizeSmall, Theme.weightHeading)).foregroundColor(Theme.ink.color)
            }
            ForEach(Array(card.rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 0) {
                    if let name = row.name { Text(name).font(Theme.body(Theme.sizeSmall)).foregroundColor(Theme.mute.color) }
                    Text(row.account).font(Theme.body(Theme.sizeBody, Theme.weightAccount)).foregroundColor(Theme.ink.color)
                        .lineLimit(2).minimumScaleFactor(0.6)
                }
            }
            // Narrower than its line at the small size: shrunk to fit, as the card on the page is.
            Text(card.shortID).font(Theme.mono(Theme.sizeSmall)).foregroundColor(Theme.mute.color)
                .lineLimit(1).minimumScaleFactor(0.5)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg.color)
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusPanel.value).stroke(Theme.ink.color, lineWidth: 1))
    }
}
