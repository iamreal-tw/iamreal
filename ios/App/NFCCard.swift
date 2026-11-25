// Source of the commands it carries (GpkiCard.swift): GpkiCard.kt of mctea01/my-Bonds-fork-android at a8696253 (Apache-2.0), https://github.com/mctea01/my-Bonds-fork-android/blob/a8696253a4c4be6c88a3618fded4c716b13f72fa/core/src/commonMain/kotlin/diw/wallet/core/document/card/GpkiCard.kt

import CoreNFC
import Foundation

/// The card over the iPhone's NFC (Core NFC): each tap is one reader
/// session, with the system's panel over the app. The panel's middle
/// sentence is design/copy/card-proof.md's ("app：感應的面板"): where to
/// hold the card while it waits, reading or signing while the commands go,
/// and that the card can be taken away when the tap is done. When a tap
/// stops the panel closes without a sentence: the step's screen says why.
///
/// What a tap does with the card is GpkiCard's; what this file adds is the
/// session around it:
///
/// - One reader session at a time: a tap asked for while one is under way
///   fails at once (`busy`) instead of starting a second session, which
///   the system holds until the first ends (issue #89).
/// - The system ends the connection about 20 seconds after the card is
///   there (issue #89), so nothing in a tap waits for a person or the
///   network: CardProofFlow does those between taps.
/// - The card applications the app selects by name are the three of
///   Config/Info.plist; the system selects the first it finds before it
///   hands the card over.
final class NFCCard: Card {
    private let copy: Copy
    private let lock = NSLock()
    private var reading = false

    init(copy: Copy) {
        self.copy = copy
    }

    func tap<T>(_ purpose: TapPurpose, _ body: (CardConnection) async throws -> T) async throws -> T {
        guard NFCTagReaderSession.readingAvailable else { throw CardFailure.noTap }
        guard claim() else { throw CardFailure.failed(code: "busy") }
        defer { release() }

        let reader = TagReader()
        let tag = try await reader.waitForCard(copy("app_panel.iphone_wait"))
        reader.say(purpose == .readCertificates ? copy("app_panel.reading") : copy("app_panel.signing"))
        let card = GpkiCard(TagTransport(tag: tag))
        do {
            let result = try await body(card)
            reader.finish(purpose == .readCertificates ? copy("app_panel.read") : copy("app_panel.signed"))
            return result
        } catch let failure as CardFailure {
            reader.stop()
            throw failure
        } catch let error as NFCReaderError {
            reader.stop()
            throw Self.failure(error, pinSent: card.pinSent)
        } catch {
            reader.stop()
            throw CardFailure.failed(code: "nfc")
        }
    }

    private func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if reading { return false }
        reading = true
        return true
    }

    private func release() {
        lock.lock()
        reading = false
        lock.unlock()
    }

    /// An error of Core NFC once the card was there.
    private static func failure(_ error: NFCReaderError, pinSent: Bool) -> CardFailure {
        switch error.code {
        case .readerTransceiveErrorTagConnectionLost, .readerTransceiveErrorTagResponseError,
             .readerTransceiveErrorRetryExceeded, .readerTransceiveErrorTagNotConnected,
             .readerTransceiveErrorSessionInvalidated, .readerSessionInvalidationErrorSessionTimeout:
            return .dropped(pinSent: pinSent)
        default:
            return .failed(code: "nfc")
        }
    }
}

/// The commands of a tap, to the card Core NFC connected to.
private struct TagTransport: APDUTransport {
    let tag: NFCISO7816Tag

    func send(_ apdu: [UInt8]) async throws -> (data: [UInt8], sw: UInt16) {
        guard let command = NFCISO7816APDU(data: Data(apdu)) else { throw CardFailure.failed(code: "apdu") }
        let (data, sw1, sw2) = try await tag.sendCommand(apdu: command)
        return (Array(data), UInt16(sw1) << 8 | UInt16(sw2))
    }
}

/// One reader session: the system's panel, from waiting for a card to the
/// end of the tap. The delegate's calls come on a queue of its own.
private final class TagReader: NSObject, NFCTagReaderSessionDelegate {
    private let queue = DispatchQueue(label: "tw.iamreal.app.nfc")
    private var session: NFCTagReaderSession?
    /// Waiting for a card; resumed once, with the card or why none came.
    private var waiting: CheckedContinuation<NFCISO7816Tag, Error>?

    /// Shows the panel with `message` and returns the card once it is
    /// connected. Throws `CardFailure.noTap` when the session ends without
    /// one: cancelled, timed out, the app went to the background.
    func waitForCard(_ message: String) async throws -> NFCISO7816Tag {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard let session = NFCTagReaderSession(pollingOption: .iso14443, delegate: self, queue: self.queue) else {
                    continuation.resume(throwing: CardFailure.noTap)
                    return
                }
                self.waiting = continuation
                self.session = session
                session.alertMessage = message
                session.begin()
            }
        }
    }

    /// The panel's middle sentence, while the tap goes on.
    func say(_ message: String) {
        queue.async { self.session?.alertMessage = message }
    }

    /// The tap is done: the panel says so as it closes.
    func finish(_ message: String) {
        queue.async {
            self.session?.alertMessage = message
            self.session?.invalidate()
        }
    }

    /// The tap stopped: the panel closes; the step's screen says why.
    func stop() {
        queue.async { self.session?.invalidate() }
    }

    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        // Before a card: no card came. After, the commands fail on their own.
        waiting?.resume(throwing: CardFailure.noTap)
        waiting = nil
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard waiting != nil else { return }
        // One card, of the kind a citizen card is; anything else, look again.
        guard tags.count == 1, case let .iso7816(card) = tags[0] else {
            session.restartPolling()
            return
        }
        session.connect(to: tags[0]) { error in
            self.queue.async {
                if error != nil {
                    session.restartPolling()
                    return
                }
                self.waiting?.resume(returning: card)
                self.waiting = nil
            }
        }
    }
}
