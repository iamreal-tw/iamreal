import Foundation
import Security
@testable import IamrealApp

/// A card made of test keys, in the place of the card read over NFC: it
/// returns its certificates, and signs with its key when the PIN is its
/// own. It records what it was asked, so that a test can say whether a PIN
/// reached it. Only in the tests: no app has it.
final class FakeCard: Card {
    let certificates: [Data]
    private let key: SecKey?
    private let pin: String

    /// Every tap, by what it was for.
    private(set) var taps: [TapPurpose] = []
    /// How many times a PIN was sent to this card.
    private(set) var pinsReceived = 0
    /// How many signatures it made.
    private(set) var signatures = 0
    /// The card the next tap finds instead of this one: the cardholder
    /// picked up another card. One tap only.
    var nextTapFinds: FakeCard?
    /// What the next signature stops at before the PIN is sent, as a
    /// card the phone cannot set up the secure channel with. One tap only.
    var nextSignFails: CardFailure?
    /// How the next taps end before anything is read or signed, one for
    /// each tap, in their order: a card that never came, a panel that was
    /// closed, a card that left.
    var nextTapsFail: [CardFailure] = []

    init(certificates: [Data], privateKey: Data, pin: String) {
        self.certificates = certificates
        self.pin = pin
        let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPrivate]
        key = SecKeyCreateWithData(privateKey as CFData, attributes as CFDictionary, nil)
    }

    func tap<T>(_ purpose: TapPurpose, _ body: (CardConnection) async throws -> T) async throws -> T {
        let card = nextTapFinds ?? self
        nextTapFinds = nil
        card.taps.append(purpose)
        if !nextTapsFail.isEmpty { throw nextTapsFail.removeFirst() }
        return try await body(Connection(card: card))
    }

    private struct Connection: CardConnection {
        let card: FakeCard

        func certificates() async throws -> [Data] {
            card.certificates
        }

        func sign(_ message: Data, pin: PIN) async throws -> Data {
            if let failure = card.nextSignFails {
                card.nextSignFails = nil
                throw failure
            }
            card.pinsReceived += 1
            guard pin.withBytes({ Array($0) }) == Array(card.pin.utf8) else { throw CardFailure.pinIncorrect }
            guard let key = card.key,
                  let signature = SecKeyCreateSignature(key, .rsaSignatureMessagePKCS1v15SHA256, message as CFData, nil)
            else { throw CardFailure.failed(code: "fake_card") }
            card.signatures += 1
            return signature as Data
        }
    }
}

/// A card that never comes: every tap ends as if no card was there. For
/// tests that tap no card.
struct NoCardReader: Card {
    func tap<T>(_ purpose: TapPurpose, _ body: (CardConnection) async throws -> T) async throws -> T {
        throw CardFailure.noTap
    }
}
