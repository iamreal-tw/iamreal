import Foundation
import Security
@testable import IamrealApp

/// A second-generation citizen card as its commands answer, to test
/// GpkiCard against: the applications and files a real card has, the
/// secure channel checked the card's way (it decrypts the data and checks
/// the MAC with its own counter), the PIN and its tries, and a signing key.
/// The key material is the one the app carries, as on a real card; the
/// certificates are made-up bytes. Only in the tests.
final class SimulatedGpkiCard: APDUTransport {
    /// What makes this card differ from a good one.
    struct Quirks {
        /// A first-generation card: no second-generation application, a master file.
        var firstGeneration = false
        /// The card's cryptogram is wrong in the last bit.
        var wrongCryptogram = false
        /// GET DATA E0 says 32-byte keys.
        var longKeys = false
    }

    static let cardID: [UInt8] = [0x24, 0x05, 0x69, 0x64, 0x13, 0x00, 0x01, 0x90, 0x39, 0x57]
    static let signingKeyRef: UInt8 = 0x81

    let certificates: [[UInt8]]
    let publicKey: SecKey
    private let privateKey: SecKey
    private let pin: [UInt8]
    private let quirks: Quirks

    /// Every command, as INS of its plain form.
    private(set) var commands: [UInt8] = []
    /// How many VERIFY commands reached the card: how many times a PIN was sent.
    private(set) var pinsReceived = 0
    private(set) var triesLeft = 3

    private enum Selected { case none, application, manager, domain, directory, file(UInt16) }
    private var selected = Selected.none
    private var hostChallenge: [UInt8] = []
    private var cardChallenge: [UInt8] = []
    private var pending: CardChannel.Session?
    private var session: (sEnc: [UInt8], sMac: [UInt8], mcv: [UInt8], counter: UInt32)?
    private var verified = false
    private var block: [UInt8] = []
    private var signature: [UInt8] = []

    init(pin: String = "123456", quirks: Quirks = Quirks()) throws {
        self.pin = Array(pin.utf8)
        self.quirks = quirks
        let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error), let publicKey = SecKeyCopyPublicKey(key) else {
            throw error!.takeRetainedValue() as Error
        }
        privateKey = key
        self.publicKey = publicKey
        // Two made-up certificates, longer than one READ BINARY.
        certificates = [Self.sequence(of: 1200, filler: 0x11), Self.sequence(of: 900, filler: 0x22)]
    }

    // The files under DF 5030 ---------------------------------------------------------

    private lazy var files: [UInt16: [UInt8]] = {
        // PrKDF: an encryption key first, then the signing key.
        let prkdf = Self.key(label: "ENC", id: Array("ENC".utf8), usage: 0x40, ref: 0x82)
            + Self.key(label: "SIGN", id: Array("SIGN".utf8), usage: 0x20, ref: Self.signingKeyRef)
            + [UInt8](repeating: 0xff, count: 40)
        // CDF: the first by a whole path with its length, the second by its file alone.
        let cdf = Self.certificateEntry(id: Array("SIGN".utf8), path: [0x3f, 0x00, 0x50, 0x30, 0x01, 0x10], length: certificates[0].count)
            + Self.certificateEntry(id: Array("ENC".utf8), path: [0x01, 0x20], length: nil)
            + [UInt8](repeating: 0x00, count: 300)
        return [0x4100: prkdf, 0x4104: cdf, 0x0110: certificates[0], 0x0120: certificates[1] + [UInt8](repeating: 0xff, count: 64)]
    }()

    // APDUTransport ---------------------------------------------------------------------

    func send(_ apdu: [UInt8]) async throws -> (data: [UInt8], sw: UInt16) {
        let cla = apdu[0], ins = apdu[1], p1 = apdu[2], p2 = apdu[3]
        var data: [UInt8] = []
        if apdu.count > 5 {
            let lc = Int(apdu[4])
            data = Array(apdu[5..<(5 + lc)])
        }
        let le = apdu.count == 5 ? (apdu[4] == 0 ? 256 : Int(apdu[4])) : (apdu.count > 5 + data.count ? Int(apdu[5 + data.count]) : 0)
        commands.append(ins)

        if cla & 0x04 != 0 && !(cla == 0x84 && ins == 0x82) {
            return secure(cla: cla, ins: ins, p1: p1, p2: p2, body: data)
        }
        switch (ins, p1) {
        case (0xa4, 0x04):
            switch data {
            case CardChannel.GPPKI_AID where !quirks.firstGeneration: selected = .application
            case CardChannel.ISD_CM_AID: selected = .manager
            case CardChannel.ISD_AID: selected = .domain
            default: return ([], 0x6a82)
            }
            session = nil
            return ([], 0x9000)
        case (0xa4, 0x00):
            let fid = UInt16(data[0]) << 8 | UInt16(data[1])
            if fid == 0x3f00 { return ([], quirks.firstGeneration ? 0x9000 : 0x6a82) }
            return select(fid)
        case (0xb0, _):
            guard case .file(let fid) = selected, let file = files[fid] else { return ([], 0x6986) }
            let offset = Int(p1) << 8 | Int(p2)
            guard offset < file.count else { return ([], 0x6b00) }
            return (Array(file[offset..<min(file.count, offset + le)]), 0x9000)
        case (0xca, _) where p2 == 0xe0:
            guard case .manager = selected else { return ([], 0x6a88) }
            let length: UInt8 = quirks.longKeys ? 0x20 : 0x10
            return ([0xe0, 0x12, 0xc0, 0x04, 0x01, 0x30, 0x03, length, 0xc0, 0x04, 0x01, 0x31, 0x03, length], 0x9000)
        case (0xca, _) where p2 == 0x45:
            guard case .domain = selected else { return ([], 0x6a88) }
            return ([0x45, 0x0a] + Self.cardID, 0x9000)
        case (0x50, _):
            guard case .application = selected else { return ([], 0x6985) }
            hostChallenge = data
            cardChallenge = [0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8]
            let keys = CardChannel.diversify(Self.cardID)
            let context = hostChallenge + cardChallenge
            let sMac = CardChannel.kdf(keys.mac, 0x06, context, bits: 128)
            var cryptogram = CardChannel.kdf(sMac, 0x00, context, bits: 64)
            if quirks.wrongCryptogram { cryptogram[7] ^= 0x01 }
            return ([UInt8](repeating: 0, count: 10) + [0x30, 0x03, 0x70] + cardChallenge + cryptogram, 0x9000)
        case (0x82, _):
            let keys = CardChannel.diversify(Self.cardID)
            let context = hostChallenge + cardChallenge
            let sMac = CardChannel.kdf(keys.mac, 0x06, context, bits: 128)
            let card = CardChannel.CardChallenge(challenge: cardChallenge, cryptogram: CardChannel.kdf(sMac, 0x00, context, bits: 64))
            guard let (opened, expected) = CardChannel.Session.establish(keys, hostChallenge: hostChallenge, card: card), expected == data else { return ([], 0x6300) }
            session = (opened.sEnc, opened.sMac, opened.mcv, 1)
            return ([], 0x9000)
        default:
            return ([], 0x6d00)
        }
    }

    private func select(_ fid: UInt16) -> (data: [UInt8], sw: UInt16) {
        switch (selected, fid) {
        case (.application, 0x5030): selected = .directory
        case (.directory, _), (.file, _):
            guard files[fid] != nil else { return ([], 0x6a82) }
            selected = .file(fid)
        default: return ([], 0x6a82)
        }
        return ([], 0x9000)
    }

    /// A command in the secure channel, checked and decrypted the card's way.
    private func secure(cla: UInt8, ins: UInt8, p1: UInt8, p2: UInt8, body: [UInt8]) -> (data: [UInt8], sw: UInt16) {
        guard var s = session, body.count >= 8 else { return ([], 0x6988) }
        let encrypted = Array(body[0..<(body.count - 8)])
        let header = [cla, ins, p1, p2, UInt8(body.count)]
        let mac = CardChannel.cmac(key: s.sMac, s.mcv + header + encrypted)
        guard Array(mac[0..<8]) == Array(body[(body.count - 8)...]) else {
            session = nil
            return ([], 0x6988)
        }
        var data: [UInt8] = []
        if !encrypted.isEmpty {
            var counterBlock = [UInt8](repeating: 0, count: 16)
            for i in 0..<4 { counterBlock[12 + i] = UInt8(truncatingIfNeeded: s.counter >> (24 - 8 * UInt32(i))) }
            let iv = CardChannel.aes(encrypt: true, key: s.sEnc, counterBlock)
            var padded = CardChannel.aes(encrypt: false, key: s.sEnc, iv: iv, encrypted)
            while padded.last == 0x00 { padded.removeLast() }
            guard padded.last == 0x80 else {
                session = nil
                return ([], 0x6988)
            }
            data = Array(padded.dropLast())
        }
        s.mcv = mac
        s.counter += 1
        session = s

        switch ins {
        case 0x20:
            pinsReceived += 1
            guard triesLeft > 0 else { return ([], 0x6983) }
            if data == pin + [UInt8](repeating: 0xff, count: 10 - pin.count) {
                triesLeft = 3
                verified = true
                return ([], 0x9000)
            }
            triesLeft -= 1
            return ([], 0x63c0 | UInt16(triesLeft))
        case 0xa4:
            return ([], [0x5030, 0x0810].contains(UInt16(data[0]) << 8 | UInt16(data[1])) ? 0x9000 : 0x6a82)
        case 0xea:
            guard verified else { return ([], 0x6982) }
            guard p2 == Self.signingKeyRef else { return ([], 0x6a88) }
            if p1 == 0x82 {
                block = data
                return ([], 0x9000)
            }
            block += data
            guard block.count == 256,
                  let made = SecKeyCreateSignature(privateKey, .rsaSignatureRaw, Data(block) as CFData, nil)
            else { return ([], 0x6a80) }
            signature = Array(made as Data)
            let first = Array(signature[0..<128])
            signature.removeFirst(128)
            return (first, 0x9000)
        case 0xc1:
            guard !signature.isEmpty else { return ([], 0x6985) }
            let next = Array(signature.prefix(128))
            signature.removeFirst(next.count)
            return (next, 0x9000)
        default:
            return ([], 0x6d00)
        }
    }

    // DER ----------------------------------------------------------------------------

    private static func tlv(_ tag: UInt8, _ value: [UInt8]) -> [UInt8] {
        let n = value.count
        let length: [UInt8] = n < 0x80 ? [UInt8(n)] : n < 0x100 ? [0x81, UInt8(n)] : [0x82, UInt8(n >> 8), UInt8(n & 0xff)]
        return [tag] + length + value
    }

    private static func integer(_ n: Int) -> [UInt8] {
        n < 0x80 ? tlv(0x02, [UInt8(n)]) : n < 0x8000 ? tlv(0x02, [UInt8(n >> 8), UInt8(n & 0xff)]) : tlv(0x02, [0x00, UInt8(n >> 8), UInt8(n & 0xff)])
    }

    private static func sequence(of length: Int, filler: UInt8) -> [UInt8] {
        // A SEQUENCE whose whole encoding is `length` bytes.
        tlv(0x30, [UInt8](repeating: filler, count: length - 4))
    }

    private static func key(label: String, id: [UInt8], usage: UInt8, ref: UInt8) -> [UInt8] {
        tlv(0x30, tlv(0x30, tlv(0x0c, Array(label.utf8))) + tlv(0x30, tlv(0x04, id) + tlv(0x03, [0x00, usage]) + integer(Int(ref))))
    }

    private static func certificateEntry(id: [UInt8], path: [UInt8], length: Int?) -> [UInt8] {
        let pathValue = tlv(0x04, path) + (length.map { integer(0) + tlv(0x80, $0 < 0x100 ? [UInt8($0)] : [UInt8($0 >> 8), UInt8($0 & 0xff)]) } ?? [])
        return tlv(0x30, tlv(0x30, tlv(0x0c, Array("CERT".utf8))) + tlv(0x30, tlv(0x04, id)) + tlv(0xa1, tlv(0x30, tlv(0x30, pathValue))))
    }
}
