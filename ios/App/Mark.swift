import SwiftUI

/// The mark: a card set at a slant, the island standing up from behind it.
/// The same drawing as web/src/ui/logo.ts, 64 × 64 units: the card in the
/// cardholder's red with a chip in the page's white, the island in ink with
/// an outline in the page's white. The outline of the main island is from
/// Natural Earth's public-domain map data (1:50m), as the page has it. It
/// holds no text and is hidden from VoiceOver.
///
/// `animated` (the small card of the last step, design/copy/card-proof.md
/// step 8): the card slides in and the island stands up, as the page's
/// style.css plays it; not when the phone is set to reduce motion.
struct Mark: View {
    var animated = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        let still = !animated || reduceMotion || shown
        GeometryReader { geometry in
            let unit = min(geometry.size.width, geometry.size.height) / 64
            ZStack {
                Canvas { context, _ in
                    context.scaleBy(x: unit, y: unit)
                    // The card, turned -9° about (27, 39).
                    context.translateBy(x: 27, y: 39)
                    context.rotate(by: .degrees(-9))
                    context.translateBy(x: -27, y: -39)
                    context.fill(Path(roundedRect: CGRect(x: 3, y: 24, width: 46, height: 30), cornerRadius: 5.5), with: .color(Theme.you.color))
                    context.fill(Path(roundedRect: CGRect(x: 9.5, y: 31, width: 10, height: 8), cornerRadius: 2), with: .color(Theme.bg.color))
                }
                .opacity(still ? 1 : 0)
                .rotationEffect(.degrees(still ? 0 : 14), anchor: UnitPoint(x: 27 / 64, y: 54 / 64))
                .offset(y: still ? 0 : 10 * unit)
                .animation(animated ? .easeOut(duration: 0.5) : nil, value: still)
                Canvas { context, _ in
                    context.scaleBy(x: unit, y: unit)
                    // The island, its outline under its fill.
                    context.translateBy(x: 31.5, y: 3)
                    context.scaleBy(x: 0.97, y: 0.97)
                    context.stroke(Self.taiwan, with: .color(Theme.bg.color), style: StrokeStyle(lineWidth: 2.6, lineJoin: .round))
                    context.fill(Self.taiwan, with: .color(Theme.ink.color))
                }
                .opacity(still ? 1 : 0)
                .scaleEffect(still ? 1 : 0.7, anchor: UnitPoint(x: 44 / 64, y: 60 / 64))
                .offset(y: still ? 0 : 26 * unit)
                .animation(animated ? .spring(response: 0.6, dampingFraction: 0.55).delay(0.35) : nil, value: still)
            }
        }
        .onAppear { shown = true }
        .accessibilityHidden(true)
    }

    /// The main island, as web/src/ui/logo.ts writes it.
    static let taiwan: Path = path(
        "M14.84 45.97 L13.85 48.00 L13.07 50.14 L12.75 52.17 L12.77 54.25 L12.55 56.14 L12.16 58.00 L10.62 57.46 L9.79 56.13 L9.59 53.94 " +
        "L8.48 51.29 L8.06 50.54 L6.45 49.06 L4.99 48.32 L3.86 47.23 L4.01 47.32 L3.18 45.85 L2.54 44.28 L1.23 39.83 L0.78 38.76 L0.17 37.78 " +
        "L0.00 36.81 L0.21 35.73 L0.77 34.12 L1.12 32.49 L0.84 30.29 L0.95 28.10 L1.37 27.13 L8.83 13.81 L10.85 10.98 L12.10 9.59 L13.14 8.02 " +
        "L14.13 6.04 L15.34 4.22 L16.21 3.67 L20.49 2.04 L21.82 0.48 L22.89 0.00 L24.10 0.03 L24.89 0.77 L25.58 1.65 L26.31 2.12 L28.21 2.98 " +
        "L29.04 3.81 L29.42 5.25 L28.26 6.60 L27.69 7.83 L27.58 9.18 L27.79 11.01 L27.82 12.85 L26.37 17.16 L24.83 19.84 L24.41 21.18 " +
        "L23.94 24.50 L23.03 27.84 L22.26 32.06 L20.99 36.41 L20.28 38.23 L19.38 39.98 L17.25 43.27 Z")

    /// A path of the form above: M, L and Z, each point two numbers.
    static func path(_ data: String) -> Path {
        var path = Path()
        for command in data.split(separator: " ", omittingEmptySubsequences: true).reduce(into: [[Substring]](), { parts, word in
            if let first = word.first, first.isLetter { parts.append([word]) } else { parts[parts.count - 1].append(word) }
        }) {
            let letter = command[0].first
            let numbers = ([command[0].dropFirst()] + command.dropFirst()).compactMap { Double($0) }
            switch letter {
            case "M" where numbers.count == 2: path.move(to: CGPoint(x: numbers[0], y: numbers[1]))
            case "L" where numbers.count == 2: path.addLine(to: CGPoint(x: numbers[0], y: numbers[1]))
            case "Z": path.closeSubpath()
            default: break
            }
        }
        return path
    }
}
