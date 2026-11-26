import SwiftUI

/// Where the card goes on an iPhone, before and while it is tapped
/// (design/screens/card-proof-app-2-read-iphone-phone.png): on the left the
/// back of the phone with its camera, the top marked; on the right the card
/// over that top, waves beside it. Under each its caption. Drawn in the
/// picture's own units (350 by 210), scaled to the width there is.
struct CardFigure: View {
    let figure: Figure

    private static let size = CGSize(width: 350, height: 210)

    var body: some View {
        VStack(spacing: 8) {
            Canvas { context, size in
                let scale = size.width / Self.size.width
                context.scaleBy(x: scale, y: scale)
                Self.draw(&context)
            }
            .aspectRatio(Self.size.width / Self.size.height, contentMode: .fit)
            .frame(maxWidth: Self.size.width)
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(figure.captions.enumerated()), id: \.offset) { _, caption in
                    Self.caption(caption)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(maxWidth: Self.size.width)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(figure.description)
        .accessibilityAddTraits(.isImage)
    }

    /// The caption in the text's color, its emphasis in ink and bold.
    private static func caption(_ caption: Figure.Caption) -> some View {
        var text = Text("")
        let parts = caption.emphasis.isEmpty ? [caption.text] : caption.text.components(separatedBy: caption.emphasis)
        for (i, part) in parts.enumerated() {
            if i > 0 {
                text = text + Text(caption.emphasis).fontWeight(.bold).foregroundColor(Theme.ink.color)
            }
            text = text + Text(part)
        }
        return text
            .font(Theme.body(Theme.sizeSmall))
            .foregroundColor(Theme.text.color)
            .multilineTextAlignment(.center)
            .lineSpacing(Theme.spacing(Theme.leadingSmall, Theme.sizeSmall))
            .fixedSize(horizontal: false, vertical: true)
    }

    private static func draw(_ context: inout GraphicsContext) {
        let ink = Theme.ink.color
        let you = Theme.you.color
        // The two backs of the phone, 182 apart.
        for x in [CGFloat(0), 182] {
            let phone = Path(roundedRect: CGRect(x: 14 + x, y: 4, width: 120, height: 196), cornerRadius: 24)
            context.fill(phone, with: .color(Theme.bg.color))
            context.stroke(phone, with: .color(ink), lineWidth: 2.5)
            let camera = Path(roundedRect: CGRect(x: 26 + x, y: 16, width: 50, height: 50), cornerRadius: 13)
            context.fill(camera, with: .color(Theme.soft.color))
            context.stroke(camera, with: .color(ink), lineWidth: 2)
            for y in [CGFloat(31), 52] {
                let lens = Path(ellipseIn: CGRect(x: 41 + x - 9, y: y - 9, width: 18, height: 18))
                context.fill(lens, with: .color(Theme.bg.color))
                context.stroke(lens, with: .color(ink), lineWidth: 2)
            }
            context.fill(Path(ellipseIn: CGRect(x: 64 + x - 4, y: 37, width: 8, height: 8)), with: .color(ink))
        }
        // Left: the top of the back, where the card goes.
        context.stroke(
            Path(roundedRect: CGRect(x: 18, y: 8, width: 112, height: 74), cornerRadius: 8),
            with: .color(you), style: StrokeStyle(lineWidth: 2.5, dash: [7, 5]))
        // Right: the card there, its chip, and the waves.
        context.fill(Path(roundedRect: CGRect(x: 190, y: 2, width: 132, height: 84), cornerRadius: 9), with: .color(you.opacity(0.88)))
        context.fill(Path(roundedRect: CGRect(x: 204, y: 58, width: 22, height: 16), cornerRadius: 3), with: .color(Theme.bg.color.opacity(0.85)))
        for (x, y, dx, dy) in [(CGFloat(328), CGFloat(18), CGFloat(11), CGFloat(13)), (338, 10, 18, 21)] {
            var wave = Path()
            wave.move(to: CGPoint(x: x, y: y))
            wave.addQuadCurve(to: CGPoint(x: x, y: y + 2 * dy), control: CGPoint(x: x + dx, y: y + dy))
            context.stroke(wave, with: .color(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
    }
}
