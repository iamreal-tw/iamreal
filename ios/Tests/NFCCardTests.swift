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
    private let failed = "沒有完成，請看 app 畫面上的說明。"

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

    private func reader(_ panel: Panel) throws -> NFCCard {
        NFCCard(copy: Copy(json: try Repository.data("design/copy/card-proof.json")), available: { true }, open: { panel })
    }

    func testTheSentenceIsTheDocuments() throws {
        let document = try Repository.text("design/copy/card-proof.md")
        XCTAssertTrue(document.contains("| 感應沒有完成 | \(failed) |"))
    }

    func testATapThatReadTheCertificatesClosesThePanelAsDone() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let read = try await reader(panel).tap(.readCertificates) { try await $0.certificates() }
        XCTAssertEqual(read.count, 2)
        XCTAssertEqual(panel.told, [
            .wait("把自然人憑證貼在 iPhone 背面的上方"),
            .say("讀取中，不要移動卡片……"),
            .finish("讀到了，可以拿開卡片"),
        ])
    }

    func testATapThatSignedClosesThePanelAsDone() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let message = self.message
        let signature = try await reader(panel).tap(.sign) { try await $0.sign(message, pin: PIN("123456")) }
        XCTAssertEqual(signature.count, 256)
        XCTAssertEqual(panel.told, [
            .wait("把自然人憑證貼在 iPhone 背面的上方"),
            .say("卡片簽章中，不要移動卡片……"),
            .finish("卡片簽好了，可以拿開卡片"),
        ])
    }

    /// A wrong PIN, as the card answers it: the tap stopped, and the panel says so.
    func testAWrongPINClosesThePanelAsAFailure() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let message = self.message
        do {
            _ = try await reader(panel).tap(.sign) { try await $0.sign(message, pin: PIN("654321")) }
            XCTFail("signed with a wrong PIN")
        } catch {
            XCTAssertEqual(error as? CardFailure, .pinIncorrect)
        }
        XCTAssertEqual(panel.told.last, .fail(failed))
        XCTAssertFalse(panel.told.contains { if case .finish = $0 { return true } else { return false } })
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
            (Other(), .failed(code: "nfc")),
        ]
        for purpose in [TapPurpose.readCertificates, .sign] {
            for (thrown, expected) in stops {
                let panel = Panel(card: try SimulatedGpkiCard())
                do {
                    try await reader(panel).tap(purpose) { _ in throw thrown }
                    XCTFail("the tap was done: \(thrown)")
                } catch {
                    XCTAssertEqual(error as? CardFailure, expected)
                }
                XCTAssertEqual(Array(panel.told.dropFirst(2)), [.fail(failed)], "\(thrown)")
            }
        }
    }

    /// Cancelled on the panel: the system has closed it, and the app closes nothing.
    func testATapCancelledOnThePanelIsNotClosedAgain() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        do {
            try await reader(panel).tap(.readCertificates) { _ in
                panel.cancelled = true
                throw CardFailure.failed(code: "nfc")
            }
            XCTFail("the tap was done")
        } catch {
            XCTAssertEqual(error as? CardFailure, .noTap)
        }
        XCTAssertEqual(panel.told.count, 2, "waiting and reading, and nothing after: \(panel.told)")
    }

    /// No card came: the system closed the panel, and the app closes nothing.
    func testAPanelThatClosedWithoutACardIsNotClosedAgain() async throws {
        let panel = Panel(card: nil)
        do {
            try await reader(panel).tap(.readCertificates) { _ in }
            XCTFail("the tap was done")
        } catch {
            XCTAssertEqual(error as? CardFailure, .noTap)
        }
        XCTAssertEqual(panel.told, [.wait("把自然人憑證貼在 iPhone 背面的上方")])
    }

    /// A phone that cannot read a card now opens no panel.
    func testNoPanelWhenReadingIsNotAvailable() async throws {
        let panel = Panel(card: try SimulatedGpkiCard())
        let card = NFCCard(copy: Copy(json: try Repository.data("design/copy/card-proof.json")), available: { false }, open: { panel })
        do {
            try await card.tap(.readCertificates) { _ in }
            XCTFail("the tap was done")
        } catch {
            XCTAssertEqual(error as? CardFailure, .noTap)
        }
        XCTAssertEqual(panel.told, [])
    }
}
