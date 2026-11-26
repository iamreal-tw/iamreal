import Security
import XCTest
@testable import IamrealApp

/// The commands to a citizen card (App/GpkiCard.swift), against a card
/// that answers them the way a second-generation card does
/// (SimulatedGpkiCard): what is read without a PIN, when the PIN is sent,
/// and when a tap stops before it is.
final class GpkiCardTests: XCTestCase {
    private let message = Data("iamreal-test:public:0".utf8)

    func testTheCertificatesAreReadInTheOrderOfTheCardWithoutAPINOrAChannel() async throws {
        let card = try SimulatedGpkiCard()
        let read = try await GpkiCard(card).certificates()
        XCTAssertEqual(read, card.certificates.map { Data($0) })
        XCTAssertEqual(card.pinsReceived, 0)
        XCTAssertFalse(card.commands.contains(0x50), "no secure channel is set up to read")
    }

    func testTheCardSignsWithItsSigningKeyAfterThePIN() async throws {
        let card = try SimulatedGpkiCard(pin: "12345678")
        let signature = try await GpkiCard(card).sign(message, pin: PIN("12345678"))
        XCTAssertEqual(signature.count, 256)
        XCTAssertTrue(SecKeyVerifySignature(card.publicKey, .rsaSignatureMessagePKCS1v15SHA256, message as CFData, signature as CFData, nil))
        XCTAssertEqual(card.pinsReceived, 1)
    }

    /// As in taps 2 and 3: the certificates, then the signature, in one connection.
    func testCertificatesThenASignatureInOneTap() async throws {
        let card = try SimulatedGpkiCard()
        let connection = GpkiCard(card)
        let read = try await connection.certificates()
        XCTAssertEqual(read.count, 2)
        let signature = try await connection.sign(message, pin: PIN("123456"))
        XCTAssertTrue(SecKeyVerifySignature(card.publicKey, .rsaSignatureMessagePKCS1v15SHA256, message as CFData, signature as CFData, nil))
    }

    func testAWrongPINIsIncorrectAndTheLastTryLocksTheCard() async throws {
        let card = try SimulatedGpkiCard()
        for _ in 0..<2 {
            do {
                _ = try await GpkiCard(card).sign(message, pin: PIN("654321"))
                XCTFail("signed with a wrong PIN")
            } catch {
                XCTAssertEqual(error as? CardFailure, .pinIncorrect)
            }
        }
        for _ in 0..<2 {
            do {
                _ = try await GpkiCard(card).sign(message, pin: PIN("654321"))
                XCTFail("signed with a wrong PIN")
            } catch {
                XCTAssertEqual(error as? CardFailure, .locked)
            }
        }
        XCTAssertEqual(card.triesLeft, 0)
    }

    func testAPINNoCardTakesIsNotSent() async throws {
        let card = try SimulatedGpkiCard()
        for pin in ["12345", "12345678901", "12345é"] {
            do {
                _ = try await GpkiCard(card).sign(message, pin: PIN(pin))
                XCTFail("signed with \(pin)")
            } catch {
                XCTAssertEqual(error as? CardFailure, .failed(code: "pin_format"))
            }
        }
        XCTAssertEqual(card.commands, [])
    }

    func testWhenTheCardsCryptogramIsWrongThePINIsNotSent() async throws {
        let card = try SimulatedGpkiCard(quirks: .init(wrongCryptogram: true))
        do {
            _ = try await GpkiCard(card).sign(message, pin: PIN("123456"))
            XCTFail("signed without a secure channel")
        } catch {
            XCTAssertEqual(error as? CardFailure, .channel)
        }
        XCTAssertEqual(card.pinsReceived, 0)
        XCTAssertFalse(card.commands.contains(0x82), "no EXTERNAL AUTHENTICATE to a card that did not prove its keys")
        XCTAssertEqual(card.commands.last, 0x50)
    }

    func testWhenTheCardHasOtherKeysThePINIsNotSent() async throws {
        let card = try SimulatedGpkiCard(quirks: .init(longKeys: true))
        do {
            _ = try await GpkiCard(card).sign(message, pin: PIN("123456"))
            XCTFail("signed without a secure channel")
        } catch {
            XCTAssertEqual(error as? CardFailure, .channel)
        }
        XCTAssertEqual(card.pinsReceived, 0)
        XCTAssertFalse(card.commands.contains(0x50))
    }

    func testAFirstGenerationCardStopsBeforeAnythingIsReadOrThePINIsSent() async throws {
        let card = try SimulatedGpkiCard(quirks: .init(firstGeneration: true))
        do {
            _ = try await GpkiCard(card).certificates()
            XCTFail("read a first-generation card")
        } catch {
            XCTAssertEqual(error as? CardFailure, .firstGeneration)
        }
        do {
            _ = try await GpkiCard(card).sign(message, pin: PIN("123456"))
            XCTFail("signed with a first-generation card")
        } catch {
            XCTAssertEqual(error as? CardFailure, .firstGeneration)
        }
        XCTAssertEqual(card.pinsReceived, 0)
        XCTAssertFalse(card.commands.contains(0xb0), "nothing is read")
    }

    /// When the card leaves, the tap says whether the PIN had been sent:
    /// what happens next depends on it (#172).
    func testWhenTheCardLeavesTheTapKnowsWhetherThePINWasSent() async throws {
        for (leavesAt, sent, fate) in [(UInt8(0x50), false, PINFate.notSent), (0x20, true, .sent), (0xea, true, .accepted)] {
            let card = try SimulatedGpkiCard(quirks: .init(leavesAt: leavesAt))
            let connection = GpkiCard(card)
            do {
                _ = try await connection.sign(message, pin: PIN("123456"))
                XCTFail("signed by a card that left")
            } catch {
                XCTAssertTrue(error is SimulatedGpkiCard.Left)
            }
            XCTAssertEqual(connection.pinSent, sent, "left at \(leavesAt)")
            // Before the channel: not sent. At the PIN's command: sent, not answered. At the signature: the card had accepted it.
            XCTAssertEqual(connection.pinFate, fate, "left at \(leavesAt)")
        }
    }
}
