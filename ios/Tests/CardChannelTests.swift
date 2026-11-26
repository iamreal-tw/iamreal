import XCTest
@testable import IamrealApp

/// The secure channel of second-generation cards against
/// spec/vectors/card-channel.json (spec/card-channel.md), field by field.
final class CardChannelTests: XCTestCase {
    private var vectors: [String: Any] = [:]

    override func setUpWithError() throws {
        vectors = try Repository.vectors("card-channel.json")
    }

    private func cases(_ name: String) throws -> [[String: Any]] {
        try XCTUnwrap(vectors[name] as? [[String: Any]], name)
    }

    func testDiversifyGivesTheCardsStaticKeys() throws {
        for c in try cases("diversify") {
            let keys = try CardChannel.diversify(
                try bytes(c, "card_id"), kek: try bytes(c, "kek"), masterEnc: try bytes(c, "master_enc"))
            XCTAssertEqual(hex(keys.enc), c["k_enc"] as? String, c["name"] as? String ?? "")
            XCTAssertEqual(hex(keys.mac), c["k_mac"] as? String, c["name"] as? String ?? "")
        }
    }

    func testTheKeyMaterialIsUpstreamsAndOnlyTheDefault() throws {
        // The card identifier of the first case with the key material the
        // app carries gives other keys than the made-up material of the vectors.
        let c = try XCTUnwrap(try cases("diversify").first)
        let made = try CardChannel.diversify(try bytes(c, "card_id"), kek: try bytes(c, "kek"), masterEnc: try bytes(c, "master_enc"))
        let carried = try CardChannel.diversify(try bytes(c, "card_id"))
        XCTAssertNotEqual(carried.enc, made.enc)
        XCTAssertEqual(CardChannel.MASTER_ENC.count, 16)
        XCTAssertEqual(CardChannel.DIVERSE_KEK.count, 16)
    }

    func testCardIdentifierFromGetData() throws {
        for c in try cases("card_id") {
            let got = CardChannel.cardID(try bytes(c, "response")).map(hex)
            XCTAssertEqual(got, c["card_id"] as? String, c["name"] as? String ?? "")
        }
    }

    func testKeyInformation() throws {
        for c in try cases("key_information") {
            XCTAssertEqual(CardChannel.acceptsKeyInformation(try bytes(c, "response")), c["accepted"] as? Bool, c["name"] as? String ?? "")
        }
    }

    func testInitializeUpdate() throws {
        for c in try cases("initialize_update") {
            let name = c["name"] as? String ?? ""
            let got = CardChannel.initializeUpdate(try bytes(c, "response"))
            XCTAssertEqual(got != nil, c["accepted"] as? Bool, name)
            if let got {
                XCTAssertEqual(hex(got.challenge), c["card_challenge"] as? String, name)
                XCTAssertEqual(hex(got.cryptogram), c["card_cryptogram"] as? String, name)
            }
        }
    }

    func testSessionKeysCryptogramsAndExternalAuthenticate() throws {
        for c in try cases("session") {
            let name = c["name"] as? String ?? ""
            let keys = CardChannel.StaticKeys(enc: try bytes(c, "k_enc"), mac: try bytes(c, "k_mac"))
            let card = CardChannel.CardChallenge(challenge: try bytes(c, "card_challenge"), cryptogram: try bytes(c, "card_cryptogram"))
            let opened = try CardChannel.Session.establish(keys, hostChallenge: try bytes(c, "host_challenge"), card: card)
            XCTAssertEqual(opened != nil, c["accepted"] as? Bool, name)
            guard let (session, authenticate) = opened else { continue }
            XCTAssertEqual(hex(session.sEnc), c["s_enc"] as? String, name)
            XCTAssertEqual(hex(session.sMac), c["s_mac"] as? String, name)
            XCTAssertEqual(hex(session.mcv), c["mcv"] as? String, name)
            let external = try XCTUnwrap(c["external_authenticate"] as? [String: String])
            XCTAssertEqual(hex(CardChannel.Session.externalAuthenticateHeader), external["header"], name)
            XCTAssertEqual(hex(authenticate), external["body"], name)
            XCTAssertEqual(session.counter, 1, name)
        }
    }

    /// The counter goes up for every command, with or without data: a
    /// counter that skips the commands without data gives the second
    /// VERIFY the wrong IV (the card answers 6988, issue #89).
    func testEveryCommandOfASessionAndItsCounter() throws {
        let sequence = try XCTUnwrap(vectors["sequence"] as? [String: Any])
        let session = CardChannel.Session(sEnc: try bytes(sequence, "s_enc"), sMac: try bytes(sequence, "s_mac"), mcv: try bytes(sequence, "mcv"))
        let steps = try XCTUnwrap(sequence["steps"] as? [[String: Any]])
        XCTAssertTrue(steps.contains { ($0["data"] as? String ?? "").isEmpty }, "the sequence has commands without data")
        for step in steps {
            let name = step["name"] as? String ?? ""
            XCTAssertEqual(Int(session.counter), step["counter"] as? Int, name)
            let wrapped = try session.wrap(
                cla: UInt8(try XCTUnwrap(step["cla"] as? Int)), ins: UInt8(try XCTUnwrap(step["ins"] as? Int)),
                p1: UInt8(try XCTUnwrap(step["p1"] as? Int)), p2: UInt8(try XCTUnwrap(step["p2"] as? Int)),
                data: try bytes(step, "data"), encrypt: try XCTUnwrap(step["encrypt"] as? Bool))
            XCTAssertEqual(hex(wrapped.header), step["header"] as? String, name)
            XCTAssertEqual(hex(wrapped.body), step["body"] as? String, name)
            XCTAssertEqual(hex(session.mcv), step["mcv"] as? String, name)
        }
    }

    func testPINBlock() throws {
        for c in try cases("pin_block") {
            let pin = PIN(try XCTUnwrap(c["pin"] as? String))
            XCTAssertEqual(CardChannel.pinBlock(pin).map(hex), c["block"] as? String, c["pin"] as? String ?? "")
        }
    }

    func testSignBlock() throws {
        let c = try XCTUnwrap(vectors["sign_block"] as? [String: Any])
        XCTAssertEqual(hex(CardChannel.signBlock(Data(try bytes(c, "message")))), c["block"] as? String)
    }

    // ---------------------------------------------------------------------------------

    private func bytes(_ c: [String: Any], _ key: String) throws -> [UInt8] {
        try XCTUnwrap(unhex(try XCTUnwrap(c[key] as? String, key)), key)
    }
}

func hex(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

func unhex(_ text: String) -> [UInt8]? {
    guard text.count % 2 == 0 else { return nil }
    var out: [UInt8] = []
    var i = text.startIndex
    while i < text.endIndex {
        let j = text.index(i, offsetBy: 2)
        guard let byte = UInt8(text[i..<j], radix: 16) else { return nil }
        out.append(byte)
        i = j
    }
    return out
}
