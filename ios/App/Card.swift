import Foundation

/// The card, as the card proof uses it: read its certificates, and with
/// the PIN have it sign. The flow (CardProofFlow) knows nothing else about
/// a card; reading one over NFC is one implementation of this (issue
/// #174), a card made of test keys is another (Tests/).
///
/// A card proof holds the card three times, each a tap:
///
///   1. the certificates are read, without a PIN;
///   2. the card signs the scope string;
///   3. the card signs the declaration code.
///
/// In taps 2 and 3 the flow reads the certificates again and compares
/// them with those of tap 1 before it hands the PIN over, so a PIN never
/// goes to another card than the one whose name the screen showed.
protocol Card {
    /// One tap: waits for a card, runs `body` with it, and lets go of the
    /// card when `body` returns or throws. Nothing in `body` waits for a
    /// person or for the network: a phone ends the connection about 20
    /// seconds after the card is there (issue #89).
    func tap<T>(_ purpose: TapPurpose, _ body: (CardConnection) async throws -> T) async throws -> T
}

/// What a tap is for: which sentences the panel shows while it lasts.
enum TapPurpose: Equatable {
    case readCertificates
    case sign
}

/// A card that is there, for the length of one tap.
protocol CardConnection {
    /// The certificates on the card (DER), in the card's order. No PIN.
    func certificates() async throws -> [Data]
    /// Sends the PIN to the card and has it sign `message` (RSA PKCS #1
    /// v1.5 with SHA-256): 256 bytes.
    func sign(_ message: Data, pin: PIN) async throws -> Data
}

/// Why a tap ended without what it was for.
enum CardFailure: Error, Equatable {
    /// No card came, or reading is not possible on this device.
    case noTap
    /// The card answered that the PIN is not the one it has.
    case pinIncorrect
    /// The card is not the one read in the first tap. The PIN was not sent.
    case otherCard
    /// Anything else the card or the connection did. `code` is a short
    /// fixed word, never a value read from the card.
    case failed(code: String)
}

/// The PIN, kept in memory only: from the field on the screen to the last
/// time it goes to the card. It is never written anywhere, and is not part
/// of what the system saves of a scene. `clear()` overwrites it; the card
/// proof clears it when it is done, cancelled or stopped.
final class PIN {
    private var bytes: [UInt8]

    init(_ text: String) {
        bytes = Array(text.utf8)
    }

    /// Nothing typed, or cleared.
    var isEmpty: Bool { bytes.isEmpty }

    /// The PIN's bytes, for the length of `body`: what a card is sent.
    func withBytes<T>(_ body: (UnsafeBufferPointer<UInt8>) throws -> T) rethrows -> T {
        try bytes.withUnsafeBufferPointer(body)
    }

    /// Overwrites the PIN with zeros and forgets it.
    func clear() {
        bytes.withUnsafeMutableBufferPointer { buffer in
            for i in buffer.indices { buffer[i] = 0 }
        }
        bytes.removeAll(keepingCapacity: false)
    }

    deinit {
        clear()
    }
}

/// The card of a build that cannot read one yet: reading over NFC is
/// issue #174. Every tap ends as if no card came.
struct NoCardReader: Card {
    func tap<T>(_ purpose: TapPurpose, _ body: (CardConnection) async throws -> T) async throws -> T {
        throw CardFailure.noTap
    }
}
