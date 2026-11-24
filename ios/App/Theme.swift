import CoreText
import SwiftUI
import UIKit

/// The values the screens are drawn with: those of design/tokens.json
/// (design/DESIGN.md), each under its name there. The app is a phone's: where
/// a token has a `-phone` value, that is the one it uses. Only the tokens the
/// app draws with are here; Tests/ThemeTests.swift checks each against the
/// file. Sizes of type follow the phone's text size (Dynamic Type): at the
/// default size they are the tokens' own.
enum Theme {
    // Colors (design/DESIGN.md, the colors): each means one thing.
    static let bg = RGB("--bg", 0xFFFFFF)
    static let ink = RGB("--ink", 0x141414)
    static let text = RGB("--text", 0x2E3135)
    static let mute = RGB("--mute", 0x5A5F64)
    static let line = RGB("--line", 0xE3E5E7)
    static let soft = RGB("--soft", 0xF6F7F7)
    /// The cardholder, the buttons and links, the cardholder's card.
    static let you = RGB("--you", 0xBF2150)
    /// A main button while it is pressed.
    static let youHover = RGB("--you-hover", 0xA51A44)

    // Sizes, in points.
    /// A step's title.
    static let sizeTitle = Length("--size-h2-phone", 28)
    static let sizeHeading = Length("--size-h3-phone", 21)
    /// An emphasised sentence.
    static let sizeLead = Length("--size-lead-phone", 19)
    static let sizeBody = Length("--size-body-phone", 16)
    static let sizeKicker = Length("--size-kicker-phone", 14)
    static let sizeSmall = Length("--size-small", 14)

    static let weightHeading = Number("--weight-heading", 700)
    static let weightAccount = Number("--weight-account", 800)
    static let weightBody = Number("--weight-body", 400)

    static let leadingTitle = Number("--leading-h2", 1.34)
    static let leadingHeading = Number("--leading-h3", 1.5)
    static let leadingBody = Number("--leading-body", 1.85)
    static let leadingKicker = Number("--leading-kicker", 1.6)
    static let leadingSmall = Number("--leading-small", 1.7)

    static let gutter = Length("--gutter-phone", 20)
    static let buttonHeight = Length("--button-height", 56)
    static let radius = Length("--radius", 4)
    static let radiusPanel = Length("--radius-panel", 12)
    static let minTarget = Length("--min-target", 44)

    /// Every value above, as design/tokens.json writes it: for the test.
    static var values: [(name: String, value: String)] {
        let colors = [bg, ink, text, mute, line, soft, you, youHover].map { ($0.name, $0.css) }
        let lengths = [sizeTitle, sizeHeading, sizeLead, sizeBody, sizeKicker, sizeSmall, gutter, buttonHeight, radius, radiusPanel, minTarget].map { ($0.name, $0.css) }
        let numbers = [weightHeading, weightAccount, weightBody, leadingTitle, leadingHeading, leadingBody, leadingKicker, leadingSmall].map { ($0.name, $0.css) }
        return colors + lengths + numbers
    }

    // Typefaces (design/DESIGN.md, the type): the headings in GenRyuMin2 TW,
    // the one typeface the app carries; the rest in the system's.

    /// The first family of --font-display.
    static let displayFamily = "GenRyuMin2 TW"
    /// Its PostScript name in the subset the app carries (design/fonts/).
    static let displayFontName = "GenRyuMin2TW-B"

    /// Makes the carried typeface known to the app, once; true when it is.
    /// The app's Info.plist is generated, so it is registered here rather
    /// than listed there.
    @discardableResult
    static func registerDisplayFont() -> Bool { registered }

    private static let registered: Bool = {
        guard let url = Bundle.main.url(forResource: displayFontName, withExtension: "otf") else { return false }
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) { return true }
        // Registered before, by this process.
        return UIFont(name: displayFontName, size: 12) != nil
    }()

    /// The headings' typeface, at `size`; all of it is the one weight, 700.
    static func display(_ size: Length) -> Font {
        registerDisplayFont()
        return .custom(displayFontName, size: size.value, relativeTo: .body)
    }

    /// The system's typeface at `size` and `weight`.
    static func body(_ size: Length, _ weight: Number = weightBody) -> Font {
        .system(size: scaled(size), weight: Font.Weight(css: weight.value))
    }

    /// The system's fixed-width typeface: short IDs and links.
    static func mono(_ size: Length) -> Font {
        .system(size: scaled(size), design: .monospaced)
    }

    /// `size` at the phone's text size.
    private static func scaled(_ size: Length) -> CGFloat {
        UIFontMetrics(forTextStyle: .body).scaledValue(for: size.value)
    }

    /// The space between lines for a line height of `leading` at `size`.
    static func spacing(_ leading: Number, _ size: Length) -> CGFloat {
        (leading.value - 1) * size.value
    }
}

/// A color of design/tokens.json.
struct RGB {
    let name: String
    let hex: UInt32
    init(_ name: String, _ hex: UInt32) { self.name = name; self.hex = hex }

    var css: String { String(format: "#%06X", hex) }
    var color: Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// A length of design/tokens.json, in points (CSS pixels).
struct Length {
    let name: String
    let value: CGFloat
    init(_ name: String, _ value: CGFloat) { self.name = name; self.value = value }

    var css: String { "\(Int(value))px" }
}

/// A unitless number of design/tokens.json: a weight or a line height.
struct Number {
    let name: String
    let value: CGFloat
    init(_ name: String, _ value: CGFloat) { self.name = name; self.value = value }

    var css: String { value == value.rounded() ? String(Int(value)) : String(describing: Double(value)) }
}

extension Font.Weight {
    /// A CSS weight: 400, 700, 800.
    init(css: CGFloat) {
        switch css {
        case ..<500: self = .regular
        case ..<650: self = .semibold
        case ..<750: self = .bold
        default: self = .heavy
        }
    }
}
