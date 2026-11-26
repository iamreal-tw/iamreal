import CoreNFC
import XCTest
@testable import IamrealApp

/// How the system's panel is closed at the end of a tap (App/NFCCard.swift),
/// with a panel that records what it is told in the place of the system's:
/// a tap that was done closes it with the sentence that the card can be
/// taken away; every tap that stopped closes it as a failure, with the one
/// sentence of design/copy/card-proof.md, so that the system does not show
/// the tick of a tap that was done (issue #367).
final class NFCCardTests: XCTestCase {
    private let message = Data("iamreal-test:public:0".utf8)
    private var copy: Copy!
    /// The one sentence of a tap that stopped.
    private var failed: String { copy("app_panel.failed") }

    override func setUpWithError() throws {
        copy = Copy(json: try Repository.data("design/copy/card-proof.json"))
    }

    /// A panel that records what it is told, over a simulated card.
    private final class Panel: CardPanel {
        enum Told: Equatable { case wait(String), say(String), finish(String), fail(String) }

        let card: SimulatedGpkiCard?
        var cancelled = false
        private(set) var told: [Told] = []

        /// `card`: nil for a panel that closes without a card.
        init(card: SimulatedGpkiCard?) {
            self.card = card
        }

        func waitForCard(_ message: String) async throws -> APDUTransport {
            told.append(.wait(message))
            guard let card else { throw CardFailure.noTap }
            return card
        }

        func say(_ message: String) { told.append(.say(message)) }
        func finish(_ message: String) { told.append(.finish(message)) }
        func fail(_ message: String) { told.append(.fail(message)) }
    }

    /// The card over NFC, with `panel` in the place of the system's.
    private func card(over panel: Panel, available: Bool = true) -> NFCCard {
        NFCCard(copy: copy, available: { available }, open: { panel })
    }

    /// The tap ends without what it was for: why.
    private func stopped(_ tap: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async -> CardFailure? {
        do {
            try await tap()
            XCTFail("the tap was done", file: file, line: line)
            return nil
        } catch {
            return error as? CardFailure
        }
    }

    /// The sentence the ticket fixed, in the document's table of the system's panel.
    func testTheSentenceIsTheDocuments() throws {
        XCTAssertEqual(failed, "沒有完成，請看 app 畫面上的說明。")
        let document = try Repository.text("design/copy/card-proof.md")
        XCTAssertTrue(document.contains("| 感應沒有完成 | \(failed) |"))
    }

    func testATapThatReadTheCertificatesClosesThePanelAsDone() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let read = try await card(over: panel).tap(.readCertificates) { try await $0.certificates() }
        XCTAssertEqual(read.count, 2)
        XCTAssertEqual(panel.told, [
            .wait(copy("app_panel.iphone_wait")),
            .say(copy("app_panel.reading")),
            .finish(copy("app_panel.read")),
        ])
    }

    func testATapThatSignedClosesThePanelAsDone() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let message = self.message
        let signature = try await card(over: panel).tap(.sign) { try await $0.sign(message, pin: PIN("123456")) }
        XCTAssertEqual(signature.count, 256)
        XCTAssertEqual(panel.told, [
            .wait(copy("app_panel.iphone_wait")),
            .say(copy("app_panel.signing")),
            .finish(copy("app_panel.signed")),
        ])
    }

    /// A wrong PIN, as the card answers it: the tap stopped, and the panel says so.
    func testAWrongPINClosesThePanelAsAFailure() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let message = self.message
        let why = await stopped { _ = try await self.card(over: panel).tap(.sign) { try await $0.sign(message, pin: PIN("654321")) } }
        XCTAssertEqual(why, .pinIncorrect)
        XCTAssertEqual(Array(panel.told.dropFirst(2)), [.fail(failed)])
    }

    /// Whatever stops a tap once the card is there, the panel is closed
    /// once, as a failure, with the one sentence; never as done.
    func testEveryTapThatStoppedClosesThePanelAsAFailure() async throws {
        struct Other: Error {}
        let stops: [(Error, CardFailure)] = [
            (CardFailure.pinIncorrect, .pinIncorrect),
            (CardFailure.locked, .locked),
            (CardFailure.channel, .channel),
            (CardFailure.firstGeneration, .firstGeneration),
            (CardFailure.otherCard, .otherCard),
            (CardFailure.dropped(pinSent: false), .dropped(pinSent: false)),
            (CardFailure.dropped(pinSent: true), .dropped(pinSent: true)),
            (CardFailure.failed(code: "card_error"), .failed(code: "card_error")),
            // As Core NFC says it: the card left, the card stopped answering, the connection ran out.
            (NFCReaderError(.readerTransceiveErrorTagConnectionLost), .dropped(pinSent: false)),
            (NFCReaderError(.readerTransceiveErrorTagResponseError), .dropped(pinSent: false)),
            (NFCReaderError(.readerSessionInvalidationErrorSessionTimeout), .dropped(pinSent: false)),
            (NFCReaderError(.readerErrorUnsupportedFeature), .failed(code: "nfc")),
            (Other(), .failed(code: "nfc")),
        ]
        for purpose in [TapPurpose.readCertificates, .sign] {
            for (thrown, expected) in stops {
                let panel = Panel(card: try SimulatedGpkiCard())
                let why = await stopped { try await self.card(over: panel).tap(purpose) { _ in throw thrown } }
                XCTAssertEqual(why, expected, "\(thrown)")
                XCTAssertEqual(Array(panel.told.dropFirst(2)), [.fail(failed)], "\(thrown)")
            }
        }
    }

    /// Cancelled on the panel: the system has closed it, and the app closes nothing.
    func testATapCancelledOnThePanelIsNotClosedAgain() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let why = await stopped {
            try await self.card(over: panel).tap(.readCertificates) { _ in
                panel.cancelled = true
                throw NFCReaderError(.readerTransceiveErrorSessionInvalidated)
            }
        }
        XCTAssertEqual(why, .noTap)
        XCTAssertEqual(panel.told.count, 2, "waiting and reading, and nothing after: \(panel.told)")
    }

    /// Cancelled on the panel after the PIN went to the card: a dropped
    /// tap, since the card may have counted the PIN; the panel is the
    /// system's to close all the same.
    func testATapCancelledAfterThePINIsDroppedAndNotClosedAgain() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let message = self.message
        let why = await stopped {
            try await self.card(over: panel).tap(.sign) { connection in
                _ = try? await connection.sign(message, pin: PIN("654321"))
                panel.cancelled = true
                throw NFCReaderError(.readerTransceiveErrorSessionInvalidated)
            }
        }
        XCTAssertEqual(why, .dropped(pinSent: true))
        XCTAssertEqual(panel.told.count, 2, "waiting and signing, and nothing after: \(panel.told)")
    }

    /// No card came: the system closed the panel, and the app closes nothing.
    func testAPanelThatClosedWithoutACardIsNotClosedAgain() async throws {
        let panel = Panel(card: nil)
        let why = await stopped { try await self.card(over: panel).tap(.readCertificates) { _ in } }
        XCTAssertEqual(why, .noTap)
        XCTAssertEqual(panel.told, [.wait(copy("app_panel.iphone_wait"))])
    }

    /// A phone that cannot read a card now opens no panel.
    func testNoPanelWhenReadingIsNotAvailable() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let why = await stopped { try await self.card(over: panel, available: false).tap(.readCertificates) { _ in } }
        XCTAssertEqual(why, .noTap)
        XCTAssertEqual(panel.told, [])
    }
}
