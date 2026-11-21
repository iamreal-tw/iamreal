import Foundation

/// Every sentence the screens show comes from design/copy/card-proof.json,
/// the form of design/copy/card-proof.md a program can read; the file is
/// carried in the app as it is in the repository. No Swift file writes a
/// sentence of its own. Placeholders are written {name}.
struct Copy {
    private let entries: [String: [String: String]]

    /// The copy carried in the app. Without the file every sentence is
    /// its key; Tests/BuildTests.swift checks that the file is there.
    static func bundled() -> Copy {
        guard let url = Bundle.main.url(forResource: "card-proof", withExtension: "json"), let json = try? Data(contentsOf: url) else {
            return Copy(json: Data())
        }
        return Copy(json: json)
    }

    init(json: Data) {
        entries = (try? JSONSerialization.jsonObject(with: json)) as? [String: [String: String]] ?? [:]
    }

    /// The sentence `key` names, written `group.name`, with its
    /// placeholders filled from `values`. A key the file does not have
    /// gives the key itself, which Tests/ looks for.
    func callAsFunction(_ key: String, _ values: [String: String] = [:]) -> String {
        let parts = key.split(separator: ".", maxSplits: 1).map(String.init)
        guard parts.count == 2, var sentence = entries[parts[0]]?[parts[1]] else { return key }
        for (name, value) in values {
            sentence = sentence.replacingOccurrences(of: "{\(name)}", with: value)
        }
        return sentence
    }
}
