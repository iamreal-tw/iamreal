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
        // A short ID is the document's example.
        sentence = sentence.replacingOccurrences(of: #"(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{10}(?![0-9A-Za-z])"#, with: "7K2Q9FM4XD", options: .regularExpression)
        // A date: the document's example of a record, or of the reminder's
        // day with its weekday (2027-02-08（星期一）, step 7, the
        // reminder), whose weekday is a word.
        let dated = [
            sentence.replacingOccurrences(of: #"\d{4}-\d{2}-\d{2}"#, with: "2026-11-16", options: .regularExpression),
            sentence.replacingOccurrences(of: #"\d{4}-\d{2}-\d{2}（星期.）"#, with: "2027-02-08（星期一）", options: .regularExpression),
        ]
        // An account: as it is, or the document's example in that sentence (`@alice`, `@bob`, `@carol.tw`).
        let candidates = dated.flatMap { sentence in
            [sentence] + ["@alice", "@bob", "@carol.tw"].map { sentence.replacingOccurrences(of: #"@[a-z0-9._]+"#, with: $0, options: .regularExpression) }
        }
        return candidates.contains { candidate in
            let pattern = NSRegularExpression.escapedPattern(for: candidate).replacingOccurrences(of: #"\d+"#, with: #"\\d+"#, options: .regularExpression)
            return self.text.range(of: pattern, options: .regularExpression) != nil
        }
    }
}
