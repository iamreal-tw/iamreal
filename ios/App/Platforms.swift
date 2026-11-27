import Foundation

/// What the screens write for each platform, fixed in the app
/// (design/copy/card-proof.md, the section on what differs by platform): its name, how an
/// account is written, how a typed account is tidied before its format is
/// checked, the key of its format hint in the copy, and the account's
/// public page. The app knows Threads; a platform of the server's table
/// that is not here is one the app does not know.
struct Platform {
    let id: String
    let name: String
    /// What the screens write before an account name.
    let prefix: String
    /// The key of the format hint in the copy.
    let formatHint: String

    /// What the cardholder typed, before its format is checked: without
    /// one leading prefix, and with `A`..`Z` in lowercase (Threads does not
    /// distinguish case). No other character is changed.
    func tidy(_ typed: String) -> String {
        let name = typed.hasPrefix(prefix) ? String(typed.dropFirst(prefix.count)) : typed
        return String(String.UnicodeScalarView(name.unicodeScalars.map { scalar in
            (65...90).contains(scalar.value) ? Unicode.Scalar(scalar.value + 32) ?? scalar : scalar
        }))
    }

    /// The account's page on the platform. Called with a username that
    /// passed the platform's format.
    func profile(_ username: String) -> URL? {
        URL(string: "https://www.threads.com/@\(username)")
    }

    /// A new post on the platform with `text` filled in: Threads's web
    /// intent, which opens the Threads app's composer where it is installed
    /// (design/copy/card-proof.md, step 8, app).
    func newPost(_ text: String) -> URL? {
        // Encoded as the web's encodeURIComponent is, so both write the same address (web/src/ui/messages.ts).
        guard let encoded = text.addingPercentEncoding(withAllowedCharacters: Self.unreserved) else { return nil }
        return URL(string: "https://www.threads.com/intent/post?text=" + encoded)
    }

    /// What encodeURIComponent leaves as it is: letters, digits and `-_.!~*'()`.
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    static let threads = Platform(id: "threads", name: "Threads", prefix: "@", formatHint: "formats.threads")

    /// The platforms the app has its own definition of.
    static let known: [Platform] = [.threads]

    static func of(_ id: String) -> Platform? {
        known.first { $0.id == id }
    }

    /// An account as the screens write it: `@alice`; as it is for a
    /// platform the app does not know.
    static func handle(_ platform: String, _ username: String) -> String {
        (of(platform)?.prefix ?? "") + username
    }
}
