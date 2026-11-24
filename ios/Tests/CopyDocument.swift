import Foundation
import XCTest
@testable import IamrealApp

/// design/copy/card-proof.md, against which a screen's sentences are held.
struct CopyDocument {
    let text: String

    static func load() throws -> CopyDocument {
        CopyDocument(text: try Repository.text("design/copy/card-proof.md"))
    }

    /// Every sentence on the screen is one of the document's: with the
    /// document's example in the place of each of `values` and any number
    /// for a number, it is in the document word for word.
    func check(_ screen: Screen, values: [String: String] = [:], file: StaticString = #filePath, line: UInt = #line) {
        for sentence in screen.texts where !sentence.isEmpty {
            XCTAssertTrue(contains(sentence, values: values), "not in design/copy/card-proof.md: \(sentence)", file: file, line: line)
        }
    }

    func contains(_ text: String, values: [String: String] = [:]) -> Bool {
        var sentence = text
        for (value, example) in values where !value.isEmpty { sentence = sentence.replacingOccurrences(of: value, with: example) }
        // A date and a short ID are the document's examples.
        sentence = sentence.replacingOccurrences(of: #"\d{4}-\d{2}-\d{2}"#, with: "2026-11-16", options: .regularExpression)
        sentence = sentence.replacingOccurrences(of: #"(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{10}(?![0-9A-Za-z])"#, with: "7K2Q9FM4XD", options: .regularExpression)
        // An account: the document's own example in that sentence, or `@alice`.
        return [sentence, sentence.replacingOccurrences(of: #"@[a-z0-9._]+"#, with: "@alice", options: .regularExpression)].contains { candidate in
            let pattern = NSRegularExpression.escapedPattern(for: candidate).replacingOccurrences(of: #"\d+"#, with: #"\\d+"#, options: .regularExpression)
            return self.text.range(of: pattern, options: .regularExpression) != nil
        }
    }
}
