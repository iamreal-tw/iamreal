import SwiftUI

/// Draws a Screen: the mark of the test roster and the name of the
/// service, which step it is, the blocks from top to bottom, the buttons.
/// It has no sentence and no decision of its own; what a button does is
/// CardProofModel.perform.
///
/// Ink on paper, one accent for the way on; no green, no tick outside the
/// two progress lists (docs/design/principles.md).
struct CardProofView: View {
    @ObservedObject var model: CardProofModel

    var body: some View {
        let screen = model.screen
        VStack(spacing: 0) {
            header(screen)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(screen.blocks.enumerated()), id: \.offset) { _, block in
                        self.block(block)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            footer(screen)
        }
        .background(Palette.paper.ignoresSafeArea())
        .foregroundColor(Palette.ink)
        .task { model.open() }
    }

    private func header(_ screen: Screen) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ScreenCopy.testRoster)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.ink, lineWidth: 1))
            HStack {
                Text(model.copy("common.service_name")).font(.headline)
                Spacer()
                Text(model.copy("common.step", ["step": String(screen.step), "steps": "6"]))
                    .font(.subheadline)
                    .foregroundColor(Palette.quiet)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().frame(height: 1).foregroundColor(Palette.rule), alignment: .bottom)
    }

    @ViewBuilder
    private func footer(_ screen: Screen) -> some View {
        if !screen.buttons.isEmpty || screen.cancel != nil {
            VStack(spacing: 10) {
                HStack(spacing: 12) {
                    ForEach(Array(screen.buttons.enumerated()), id: \.offset) { index, button in
                        self.button(button, primary: index == screen.buttons.count - 1)
                    }
                }
                if let cancel = screen.cancel {
                    SwiftUI.Button(cancel.label) { model.perform(cancel.action) }
                        .font(.subheadline)
                        .foregroundColor(Palette.quiet)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .overlay(Rectangle().frame(height: 1).foregroundColor(Palette.rule), alignment: .top)
        }
    }

    private func button(_ button: Button, primary: Bool) -> some View {
        SwiftUI.Button { model.perform(button.action) } label: {
            Text(button.label)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .foregroundColor(primary ? Palette.paper : Palette.ink)
                .background(primary ? Palette.accent : Palette.paper)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(primary ? Palette.accent : Palette.ink, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .disabled(!button.enabled)
        .opacity(button.enabled ? 1 : 0.45)
    }

    @ViewBuilder
    private func block(_ block: Block) -> some View {
        switch block {
        case .title(let text):
            Text(text).font(.title2.weight(.bold)).padding(.bottom, 2)
        case .heading(let text):
            Text(text).font(.headline).padding(.top, 10)
        case .text(let text):
            Text(text).font(.body)
        case .strong(let text):
            Text(text).font(.body.weight(.semibold))
        case .hand(let text):
            Text(text).font(.callout.italic()).foregroundColor(Palette.accent)
        case .points(let points):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: "·")
                        Text(point)
                    }
                    .font(.subheadline)
                }
            }
        case .question(let question, let answer):
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(answer.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.top, 6)
            } label: {
                Text(question).font(.subheadline.weight(.semibold))
            }
            .accentColor(Palette.ink)
        case .items(let items):
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    self.item(item)
                }
            }
            .padding(.vertical, 4)
        case .cardName(let label, let name, let note):
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.subheadline).foregroundColor(Palette.quiet)
                Text(name).font(.title3.weight(.semibold))
                Text(note).font(.footnote).foregroundColor(Palette.quiet)
            }
        case .pinField(let label):
            HStack(spacing: 12) {
                Text(label).font(.body.weight(.semibold))
                // No content type: the system is not to offer to fill the PIN in, or to save it.
                SecureField("", text: $model.pinText)
                    .keyboardType(.asciiCapable)
                    .padding(10)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.ink, lineWidth: 1))
                    .accessibilityLabel(label)
            }
        case .message(let text):
            Text(text).font(.subheadline.weight(.semibold))
                .padding(.leading, 10)
                .overlay(Rectangle().frame(width: 3).foregroundColor(Palette.ink), alignment: .leading)
        case .account(let row):
            self.account(row)
        case .row(let name, let account, let lines):
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(name).font(.subheadline).foregroundColor(Palette.quiet).frame(width: 84, alignment: .leading)
                    Text(account).font(.body.monospaced())
                }
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.footnote).padding(.leading, 96)
                }
            }
        case .pair(let label, let value):
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(label).font(.subheadline).foregroundColor(Palette.quiet).frame(width: 84, alignment: .leading)
                Text(value).font(.body.monospaced())
            }
        case .link(let text):
            Text(text).font(.body.monospaced()).textSelection(.enabled)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.rule, lineWidth: 1))
        case .button(let button):
            SwiftUI.Button(button.label) { model.perform(button.action) }
                .font(.subheadline.weight(.semibold))
                .foregroundColor(Palette.accent)
        case .busy(let text):
            HStack(spacing: 10) {
                ProgressView()
                Text(text).font(.subheadline)
            }
        }
    }

    private func item(_ item: Item) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Group {
                switch item.state {
                case .done: Image(systemName: "checkmark")
                case .working: ProgressView().scaleEffect(0.7)
                case .pending, .halted: Image(systemName: "circle").foregroundColor(Palette.quiet)
                }
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.label).font(.body)
                if !item.status.isEmpty {
                    Text(item.status).font(.footnote.weight(item.state == .halted ? .semibold : .regular)).foregroundColor(item.state == .halted ? Palette.ink : Palette.quiet)
                }
                ForEach(Array(item.why.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.subheadline.weight(.semibold))
                }
            }
        }
    }

    private func account(_ row: AccountRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(row.name).font(.subheadline).foregroundColor(Palette.quiet).frame(width: 64, alignment: .leading)
                Text(row.prefix).font(.body.monospaced())
                TextField("", text: Binding(get: { row.text }, set: { model.type($0, on: row.platform) }))
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .keyboardType(.asciiCapable)
                    .padding(8)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.ink, lineWidth: 1))
                    .accessibilityLabel(row.name)
                if let preview = row.preview {
                    SwiftUI.Button(preview.label) { model.perform(preview.action) }
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(Palette.accent)
                }
            }
            ForEach(Array(row.lines.enumerated()), id: \.offset) { _, line in
                Text(line).font(.footnote).foregroundColor(Palette.quiet)
            }
            if let error = row.error {
                Text(error).font(.footnote.weight(.semibold))
            }
        }
    }
}

/// The colors of the screens, those of the web page (web/src/ui/style.css):
/// ink on paper, and one accent.
private enum Palette {
    static let paper = Color(red: 0xf4 / 255, green: 0xf1 / 255, blue: 0xea / 255)
    static let ink = Color(red: 0x1b / 255, green: 0x1b / 255, blue: 0x1f / 255)
    static let quiet = Color(red: 0x6b / 255, green: 0x68 / 255, blue: 0x60 / 255)
    static let rule = Color(red: 0xd8 / 255, green: 0xd3 / 255, blue: 0xc7 / 255)
    static let accent = Color(red: 0x22 / 255, green: 0x69 / 255, blue: 0x77 / 255)
}
