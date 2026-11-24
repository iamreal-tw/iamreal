import CoreText
import XCTest
@testable import IamrealApp

/// The theme's values are design/tokens.json's (design/DESIGN.md, the
/// values): each value the app draws with, under the name it has there.
final class ThemeTests: XCTestCase {
    private func tokens() throws -> [String: String] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: Repository.data("design/tokens.json")) as? [String: String])
    }

    func testEveryValueOfTheThemeIsTheOneOfTokensJSON() throws {
        let tokens = try tokens()
        let values = Theme.values
        XCTAssertGreaterThan(values.count, 20)
        for (name, value) in values {
            XCTAssertEqual(value, tokens[name], name)
        }
        XCTAssertEqual(Set(values.map(\.name)).count, values.count, "each token once")
    }

    /// The headings' typeface is the first of --font-display, and it is the
    /// one the app carries: the subset of design/fonts/.
    func testTheHeadingsAreInTheTypefaceTheAppCarries() throws {
        let display = try XCTUnwrap(try tokens()["--font-display"])
        let first = try XCTUnwrap(display.split(separator: ",").first).trimmingCharacters(in: CharacterSet(charactersIn: "\" "))
        XCTAssertEqual(first, Theme.displayFamily)
        let url = try XCTUnwrap(Bundle.main.url(forResource: "GenRyuMin2TW-B", withExtension: "otf"))
        let descriptors = try XCTUnwrap(CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor])
        let name = try XCTUnwrap(descriptors.first.flatMap { CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String })
        XCTAssertEqual(name, Theme.displayFontName)
        let family = try XCTUnwrap(descriptors.first.flatMap { CTFontDescriptorCopyAttribute($0, kCTFontFamilyNameAttribute) as? String })
        XCTAssertTrue(family.hasPrefix(Theme.displayFamily), family)
        XCTAssertTrue(Theme.registerDisplayFont())
    }
}
