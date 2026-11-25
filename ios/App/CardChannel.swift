// Source: GpkiCard.kt of mctea01/my-Bonds-fork-android at a8696253 (Apache-2.0), https://github.com/mctea01/my-Bonds-fork-android/blob/a8696253a4c4be6c88a3618fded4c716b13f72fa/core/src/commonMain/kotlin/diw/wallet/core/document/card/GpkiCard.kt

import CommonCrypto
import Foundation

/// The secure channel a second-generation card requires before it takes a
/// PIN or signs (GlobalPlatform SCP03), and the blocks sent in it: what
/// spec/card-channel.md defines, field by field as in
/// spec/vectors/card-channel.json (Tests/CardChannelTests.swift). The
/// commands that carry these to a card are in GpkiCard.swift.
///
/// One difference from the upstream file, as the spec has it: the counter
/// goes up for every command of the session, also those without data.
enum CardChannel {
    // The card's applications and the key material, as the upstream file has them.
    static let GPPKI_AID: [UInt8] = bytes("A0000002830000062201696400010101")
    static let ISD_CM_AID: [UInt8] = bytes("A000000283FF088692535389C00014")
    static let ISD_AID: [UInt8] = bytes("A0000001510000")
    static let MASTER_ENC: [UInt8] = bytes("eee765099e9b8d52a33734760dd0305e")
    static let DIVERSE_KEK: [UInt8] = bytes("434854204869434f53504b4353233131")
    static let SHA256_DIGEST_INFO: [UInt8] = bytes("3031300d060960864801650304020105000420")

    /// The card's static keys.
    struct StaticKeys {
        var enc: [UInt8]
        var mac: [UInt8]

        mutating func wipe() {
            CardChannel.wipe(&enc)
            CardChannel.wipe(&mac)
        }
    }

    /// The card's static keys from its 10-byte identifier (`diversify`).
    /// The key material is the upstream file's unless the vectors give theirs.
    static func diversify(_ cardID: [UInt8], kek: [UInt8] = DIVERSE_KEK, masterEnc: [UInt8] = MASTER_ENC) -> StaticKeys {
        var master = aes(encrypt: false, key: kek, masterEnc)
        defer { wipe(&master) }
        func derive(_ constant: UInt8) -> [UInt8] {
            var input = [UInt8](repeating: 0, count: 32)
            input[0x0b] = constant
            input[0x0e] = 0x80
            input[0x0f] = 0x01
            input[0x10] = constant == 0x04 ? 0x01 : 0x02
            input.replaceSubrange(0x11..<0x1b, with: cardID)
            input.replaceSubrange(0x1b..<0x20, with: ISD_CM_AID[10..<15])
            return cmac(key: master, input)
        }
        return StaticKeys(enc: derive(0x04), mac: derive(0x06))
    }

    /// The card identifier in GET DATA 45's answer (`card_id`).
    static func cardID(_ response: [UInt8]) -> [UInt8]? {
        guard response.count >= 12, response[0] == 0x45, response[1] == 0x0a else { return nil }
        return Array(response[2..<12])
    }

    /// Whether GET DATA E0's answer says 16-byte keys (`key_information`).
    static func acceptsKeyInformation(_ response: [UInt8]) -> Bool {
        response.count >= 8 && response[0] == 0xe0 && response[7] == 0x10
    }

    /// What the card answers INITIALIZE UPDATE with.
    struct CardChallenge {
        var challenge: [UInt8]
        var cryptogram: [UInt8]
    }

    /// The card's challenge and cryptogram, when the answer is SCP03's (`initialize_update`).
    static func initializeUpdate(_ response: [UInt8]) -> CardChallenge? {
        guard response.count >= 29, response[11] == 0x03 else { return nil }
        return CardChallenge(challenge: Array(response[13..<21]), cryptogram: Array(response[21..<29]))
    }

    /// One secure channel: from EXTERNAL AUTHENTICATE to the end of the tap.
    final class Session {
        static let externalAuthenticateHeader: [UInt8] = [0x84, 0x82, 0x03, 0x00, 0x10]

        private(set) var sEnc: [UInt8]
        private(set) var sMac: [UInt8]
        /// The chaining value the next command's MAC starts from.
        private(set) var mcv: [UInt8]
        /// The number of the next command: 1 for the first after EXTERNAL AUTHENTICATE.
        private(set) var counter: UInt32 = 1

        init(sEnc: [UInt8], sMac: [UInt8], mcv: [UInt8]) {
            self.sEnc = sEnc
            self.sMac = sMac
            self.mcv = mcv
        }

        /// The session, and the data of EXTERNAL AUTHENTICATE; nil when the
        /// card's cryptogram is not the one its keys give (`session`).
        static func establish(_ keys: StaticKeys, hostChallenge: [UInt8], card: CardChallenge) -> (Session, [UInt8])? {
            let context = hostChallenge + card.challenge
            var sMac = kdf(keys.mac, 0x06, context, bits: 128)
            var sEnc = kdf(keys.enc, 0x04, context, bits: 128)
            guard kdf(sMac, 0x00, context, bits: 64) == card.cryptogram else {
                CardChannel.wipe(&sMac)
                CardChannel.wipe(&sEnc)
                return nil
            }
            let hostCryptogram = kdf(sMac, 0x01, context, bits: 64)
            let mcv = cmac(key: sMac, [UInt8](repeating: 0, count: 16) + externalAuthenticateHeader + hostCryptogram)
            return (Session(sEnc: sEnc, sMac: sMac, mcv: mcv), hostCryptogram + mcv[0..<8])
        }

        /// A command in the channel (`sequence`): the header with the
        /// secure-messaging class, and the body (the encrypted data, then
        /// 8 bytes of the MAC). The counter goes up for every command.
        func wrap(cla: UInt8, ins: UInt8, p1: UInt8, p2: UInt8, data: [UInt8], encrypt: Bool) -> (header: [UInt8], body: [UInt8]) {
            var encrypted: [UInt8] = []
            if encrypt && !data.isEmpty {
                var block = [UInt8](repeating: 0, count: 16)
                block[12] = UInt8(truncatingIfNeeded: counter >> 24)
                block[13] = UInt8(truncatingIfNeeded: counter >> 16)
                block[14] = UInt8(truncatingIfNeeded: counter >> 8)
                block[15] = UInt8(truncatingIfNeeded: counter)
                let iv = aes(encrypt: true, key: sEnc, block)
                var padded = data + [0x80]
                while padded.count % 16 != 0 { padded.append(0) }
                defer { CardChannel.wipe(&padded) }
                encrypted = aes(encrypt: true, key: sEnc, iv: iv, padded)
            }
            counter += 1
            let header = [cla | 0x04, ins, p1, p2, UInt8(encrypted.count + 8)]
            mcv = cmac(key: sMac, mcv + header + encrypted)
            return (header, encrypted + mcv[0..<8])
        }

        /// Overwrites the session keys.
        func wipe() {
            CardChannel.wipe(&sEnc)
            CardChannel.wipe(&sMac)
            CardChannel.wipe(&mcv)
        }

        deinit { wipe() }
    }

    /// The data of VERIFY: the PIN padded with FF to 10 bytes; nil for a
    /// PIN no card takes (`pin_block`).
    static func pinBlock(_ pin: PIN) -> [UInt8]? {
        pin.withBytes { pin in
            guard (6...10).contains(pin.count), pin.allSatisfy({ (0x20...0x7e).contains($0) }) else { return nil }
            return Array(pin) + [UInt8](repeating: 0xff, count: 10 - pin.count)
        }
    }

    /// What the card is given to sign for `message` (`sign_block`):
    /// EMSA-PKCS1-v1_5 with SHA-256 for a 2048-bit key.
    static func signBlock(_ message: Data) -> [UInt8] {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        message.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(message.count), &digest) }
        let t = SHA256_DIGEST_INFO + digest
        return [0x00, 0x01] + [UInt8](repeating: 0xff, count: 256 - 3 - t.count) + [0x00] + t
    }

    // The primitives ------------------------------------------------------------------

    /// `kdf` of spec/card-channel.md (SCP03's, NIST SP 800-108 in counter mode with AES-CMAC).
    static func kdf(_ key: [UInt8], _ constant: UInt8, _ context: [UInt8], bits: Int) -> [UInt8] {
        let length = (bits + 7) / 8
        var out: [UInt8] = []
        var i: UInt8 = 1
        while out.count < length {
            let input = [UInt8](repeating: 0, count: 11) + [constant, 0x00, UInt8(bits >> 8), UInt8(bits & 0xff), i] + context
            out += cmac(key: key, input)
            i += 1
        }
        return Array(out[0..<length])
    }

    /// AES-CMAC (RFC 4493).
    static func cmac(key: [UInt8], _ data: [UInt8]) -> [UInt8] {
        func double(_ b: [UInt8]) -> [UInt8] {
            var out = [UInt8](repeating: 0, count: 16)
            for i in 0..<16 { out[i] = (b[i] << 1) | (i < 15 ? b[i + 1] >> 7 : 0) }
            if b[0] & 0x80 != 0 { out[15] ^= 0x87 }
            return out
        }
        let k1 = double(aes(encrypt: true, key: key, [UInt8](repeating: 0, count: 16)))
        let k2 = double(k1)
        let blocks = max(1, (data.count + 15) / 16)
        let complete = !data.isEmpty && data.count % 16 == 0
        var last = [UInt8](repeating: 0, count: 16)
        let start = (blocks - 1) * 16
        if complete {
            for i in 0..<16 { last[i] = data[start + i] ^ k1[i] }
        } else {
            for i in 0..<(data.count - start) { last[i] = data[start + i] }
            last[data.count - start] = 0x80
            for i in 0..<16 { last[i] ^= k2[i] }
        }
        var x = [UInt8](repeating: 0, count: 16)
        for b in 0..<(blocks - 1) {
            for i in 0..<16 { x[i] ^= data[b * 16 + i] }
            x = aes(encrypt: true, key: key, x)
        }
        for i in 0..<16 { x[i] ^= last[i] }
        return aes(encrypt: true, key: key, x)
    }

    /// AES-128 in ECB (no `iv`) or CBC, without padding.
    static func aes(encrypt: Bool, key: [UInt8], iv: [UInt8]? = nil, _ data: [UInt8]) -> [UInt8] {
        precondition(key.count == 16 && data.count % 16 == 0)
        var out = [UInt8](repeating: 0, count: data.count)
        var moved = 0
        let status = CCCrypt(
            CCOperation(encrypt ? kCCEncrypt : kCCDecrypt), CCAlgorithm(kCCAlgorithmAES),
            CCOptions(iv == nil ? kCCOptionECBMode : 0),
            key, key.count, iv, data, data.count, &out, out.count, &moved)
        precondition(status == kCCSuccess && moved == data.count)
        return out
    }

    /// Overwrites the bytes with zeros.
    static func wipe(_ bytes: inout [UInt8]) {
        for i in bytes.indices { bytes[i] = 0 }
    }

    private static func bytes(_ hex: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            out.append(UInt8(hex[i..<j], radix: 16)!)
            i = j
        }
        return out
    }
}
