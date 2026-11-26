// Source: GpkiCard.kt of mctea01/my-Bonds-fork-android at a8696253 (Apache-2.0), https://github.com/mctea01/my-Bonds-fork-android/blob/a8696253a4c4be6c88a3618fded4c716b13f72fa/core/src/commonMain/kotlin/diw/wallet/core/document/card/GpkiCard.kt

import Foundation
import Security

/// What carries a card's commands, for the length of one tap: the iPhone's
/// NFC (NFCCard.swift), or a card simulated in Tests/.
protocol APDUTransport {
    /// Sends one whole command APDU; the response's data and status word.
    func send(_ apdu: [UInt8]) async throws -> (data: [UInt8], sw: UInt16)
}

/// A citizen digital certificate card, as the commands of the upstream file
/// (spec/card-channel.md) speak to it: its certificates, read without a PIN
/// (PKCS #15 under DF 5030), and a signature with the PIN, in the secure
/// channel a second-generation card requires (CardChannel.swift).
///
/// Only second-generation cards: a first-generation card is told apart
/// and stops the tap (`CardFailure.firstGeneration`) before anything is
/// read or a PIN is sent. A PIN goes to the card only once the secure
/// channel is up: when it cannot be set up the tap stops with
/// `CardFailure.channel` and the PIN was not sent.
final class GpkiCard: CardConnection {
    private let transport: APDUTransport
    private var connected = false
    /// Whether VERIFY, with the PIN, has been handed to the transport.
    private(set) var pinSent = false
    /// The card answered that the PIN is its own.
    private(set) var pinAccepted = false

    /// What has become of the PIN in this connection.
    var pinFate: PINFate { pinAccepted ? .accepted : pinSent ? .sent : .notSent }

    init(_ transport: APDUTransport) {
        self.transport = transport
    }

    // The files on the card.
    private static let cardDirectory: UInt16 = 0x5030
    private static let keyFile: UInt16 = 0x0810
    private static let privateKeyDirectory: UInt16 = 0x4100
    private static let certificateDirectory: UInt16 = 0x4104
    private static let chunk = 0xc8
    private static let signatureLength = 256

    // CardConnection ----------------------------------------------------------------

    /// The certificates the card's certificateDirectory names, in its order. None when the
    /// card has no certificateDirectory: the core then says it has no certificate.
    func certificates() async throws -> [Data] {
        try await connect()
        var certificates: [Data] = []
        for entry in Der.records(try await readDirectory(Self.certificateDirectory)) {
            guard let path = Self.certificatePath(entry) else { continue }
            try await selectPath(path.path)
            let raw = try await readRange(path.index, path.length > 0 ? path.length : 4096)
            guard let der = Der.firstObject(raw) else { throw CardFailure.failed(code: "certificate_format") }
            certificates.append(Data(der))
        }
        return certificates
    }

    /// The PIN to the card, then the card's signature of `message`
    /// (RSASSA-PKCS1-v1_5 with SHA-256), in one secure channel.
    func sign(_ message: Data, pin: PIN) async throws -> Data {
        // A PIN no card takes is not sent (the screen does not let one through).
        guard var pinBlock = CardChannel.pinBlock(pin) else { throw CardFailure.failed(code: "pin_format") }
        defer { CardChannel.wipe(&pinBlock) }
        try await connect()
        let keyRef = try await signingKeyRef()
        let session = try await openChannel()
        defer { session.wipe() }

        pinSent = true
        let verify = try await secure(session, cla: 0x00, ins: 0x20, p1: 0x00, p2: 0x01, data: pinBlock, le: 0, encrypt: true)
        switch verify.sw {
        case 0x9000: pinAccepted = true
        case 0x6983, 0x63c0: throw CardFailure.locked
        case 0x63c1...0x63cf: throw CardFailure.pinIncorrect
        default: throw CardFailure.failed(code: "pin_refused")
        }
        for fid in [Self.cardDirectory, Self.keyFile] {
            let selected = try await secure(session, cla: 0x00, ins: 0xa4, p1: 0x00, p2: 0x04, data: Self.bytes(fid), le: 0, encrypt: true)
            guard Self.selected(selected.sw) else { throw CardFailure.failed(code: "select_key") }
        }
        var block = CardChannel.signBlock(message)
        defer { CardChannel.wipe(&block) }
        // Room for the whole of it up front, so that no copy is left behind unwiped.
        var signature: [UInt8] = []
        signature.reserveCapacity(Self.signatureLength + 128)
        defer { CardChannel.wipe(&signature) }
        for half in 0..<2 {
            let more = half == 0
            let r = try await secure(
                session, cla: 0x80, ins: 0xea, p1: more ? 0x82 : 0x02, p2: keyRef,
                data: Array(block[(half * 128)..<(half * 128 + 128)]), le: more ? 0 : 0x80, encrypt: true)
            guard Self.ok(r.sw) else { throw CardFailure.failed(code: "sign_refused") }
            signature += r.data
        }
        var reads = 0
        while signature.count < Self.signatureLength && reads < 4 {
            let r = try await secure(session, cla: 0x80, ins: 0xc1, p1: 0x00, p2: 0x80, data: [], le: 0x80, encrypt: false)
            guard Self.ok(r.sw), !r.data.isEmpty else { throw CardFailure.failed(code: "sign_read") }
            signature += r.data
            reads += 1
        }
        guard signature.count >= Self.signatureLength else { throw CardFailure.failed(code: "sign_length") }
        return Data(signature[0..<Self.signatureLength])
    }

    // The application ---------------------------------------------------------------

    /// Selects the second-generation application. A card without it whose
    /// master file can be selected is a first-generation card.
    private func connect() async throws {
        if connected { return }
        if try await selectApplication() {
            connected = true
            return
        }
        for cla: UInt8 in [0x80, 0x00] {
            if Self.ok(try await transmit(cla, 0xa4, 0x00, 0x00, [0x3f, 0x00], le: 0).sw) {
                throw CardFailure.firstGeneration
            }
        }
        throw CardFailure.failed(code: "not_a_citizen_card")
    }

    private func selectApplication() async throws -> Bool {
        Self.ok(try await transmit(0x00, 0xa4, 0x04, 0x0c, CardChannel.GPPKI_AID, le: 256).sw)
    }

    private func selectFid(_ fid: UInt16) async throws -> Bool {
        let sw = try await transmit(0x00, 0xa4, 0x00, 0x04, Self.bytes(fid), le: 256).sw
        return Self.selected(sw)
    }

    private func selectPath(_ path: [UInt8]) async throws {
        var i = 0
        guard try await selectApplication() else { throw CardFailure.failed(code: "select_application") }
        if path.count >= 2 && path[0] == 0x3f && path[1] == 0x00 {
            i = 2
        } else if path.count <= 2 {
            guard try await selectFid(Self.cardDirectory) else { throw CardFailure.failed(code: "select_directory") }
        }
        while i + 1 < path.count {
            let fid = UInt16(path[i]) << 8 | UInt16(path[i + 1])
            if fid == 0x7fff {
                guard try await selectApplication() else { throw CardFailure.failed(code: "select_application") }
            } else {
                guard try await selectFid(fid) else { throw CardFailure.failed(code: "select_file") }
            }
            i += 2
        }
    }

    private func readBinary(_ offset: Int, _ want: Int) async throws -> [UInt8]? {
        var want = want
        while true {
            let r = try await transmit(0x00, 0xb0, UInt8((offset >> 8) & 0x7f), UInt8(offset & 0xff), [], le: want)
            if r.sw == 0x6987 && want > 16 {
                want = 16
                continue
            }
            return Self.selected(r.sw) ? r.data : nil
        }
    }

    private func readRange(_ offset: Int, _ length: Int) async throws -> [UInt8] {
        var out: [UInt8] = []
        var offset = offset
        while out.count < length {
            let want = min(Self.chunk, length - out.count)
            guard let got = try await readBinary(offset, want), !got.isEmpty else { break }
            out += got
            offset += got.count
            if got.count < want { break }
        }
        return out
    }

    /// A PKCS #15 directory file under DF 5030, up to the padding after its
    /// last record; empty when the card has no such file.
    private func readDirectory(_ fid: UInt16) async throws -> [UInt8] {
        guard try await selectApplication(), try await selectFid(Self.cardDirectory), try await selectFid(fid) else { return [] }
        var buffer: [UInt8] = []
        while buffer.count < 16 * 1024 {
            guard let got = try await readBinary(buffer.count, Self.chunk), !got.isEmpty else { break }
            buffer += got
            if let end = Der.recordsEnd(buffer) { return Array(buffer[0..<end]) }
            if got.count < Self.chunk { break }
        }
        return buffer
    }

    /// The reference of the signing key: the PrKDF's key that may sign,
    /// the one labelled SIGN first.
    private func signingKeyRef() async throws -> UInt8 {
        let keys = Der.records(try await readDirectory(Self.privateKeyDirectory)).compactMap(Self.key)
        let signers = keys.filter(\.canSign)
        guard let key = signers.first(where: { $0.id == Array("SIGN".utf8) || $0.label.uppercased().contains("SIGN") }) ?? signers.first ?? keys.first,
              let ref = UInt8(exactly: key.keyRef)
        else { throw CardFailure.failed(code: "no_key") }
        return ref
    }

    // The secure channel --------------------------------------------------------------

    /// Sets up the secure channel (spec/card-channel.md). Whatever the
    /// card answers on the way, short of the connection itself failing,
    /// ends in `CardFailure.channel`: nothing after it is sent.
    private func openChannel() async throws -> CardChannel.Session {
        let manager = try await transmit(0x00, 0xa4, 0x04, 0x00, CardChannel.ISD_CM_AID, le: 0).sw
        guard Self.selected(manager) else { throw CardFailure.channel }
        let information = try await transmit(0x80, 0xca, 0x00, 0xe0, [], le: 256)
        guard Self.ok(information.sw), CardChannel.acceptsKeyInformation(information.data) else { throw CardFailure.channel }
        let domain = try await transmit(0x00, 0xa4, 0x04, 0x00, CardChannel.ISD_AID, le: 0).sw
        guard Self.selected(domain) else { throw CardFailure.channel }
        let identifier = try await transmit(0x80, 0xca, 0x00, 0x45, [], le: 256)
        guard Self.ok(identifier.sw), let cardID = CardChannel.cardID(identifier.data) else { throw CardFailure.channel }
        var keys = try CardChannel.diversify(cardID)
        defer { keys.wipe() }

        guard try await selectApplication() else { throw CardFailure.channel }
        var host = [UInt8](repeating: 0, count: 8)
        guard SecRandomCopyBytes(kSecRandomDefault, host.count, &host) == errSecSuccess else { throw CardFailure.channel }
        let update = try await transmit(0x80, 0x50, 0x01, 0x00, host, le: 256)
        guard Self.ok(update.sw), let card = CardChannel.initializeUpdate(update.data),
              let (session, authenticate) = try CardChannel.Session.establish(keys, hostChallenge: host, card: card)
        else { throw CardFailure.channel }
        guard Self.ok(try await transmit(0x84, 0x82, 0x03, 0x00, authenticate, le: 0).sw) else {
            session.wipe()
            throw CardFailure.channel
        }
        return session
    }

    private func secure(_ session: CardChannel.Session, cla: UInt8, ins: UInt8, p1: UInt8, p2: UInt8, data: [UInt8], le: Int, encrypt: Bool) async throws -> (data: [UInt8], sw: UInt16) {
        var (header, body) = try session.wrap(cla: cla, ins: ins, p1: p1, p2: p2, data: data, encrypt: encrypt)
        defer { CardChannel.wipe(&body) }
        return try await transmit(header[0], ins, p1, p2, body, le: le)
    }

    // Commands --------------------------------------------------------------------

    /// One command in the short form: `le` 0 sends none, 256 sends 00. A
    /// 6Cxx answer is sent again with that length; 61xx is followed by
    /// GET RESPONSE.
    private func transmit(_ cla: UInt8, _ ins: UInt8, _ p1: UInt8, _ p2: UInt8, _ data: [UInt8], le: Int) async throws -> (data: [UInt8], sw: UInt16) {
        func apdu(_ le: Int) -> [UInt8] {
            var apdu = [cla, ins, p1, p2]
            if !data.isEmpty { apdu += [UInt8(data.count)] + data }
            if le > 0 { apdu.append(le == 256 ? 0 : UInt8(le)) }
            return apdu
        }
        var (out, sw) = try await transport.send(apdu(le))
        if sw >> 8 == 0x6c { (out, sw) = try await transport.send(apdu(sw & 0xff == 0 ? 256 : Int(sw & 0xff))) }
        var more = 0
        while sw >> 8 == 0x61 && more < 32 {
            let next = try await transport.send([0x00, 0xc0, 0x00, 0x00, UInt8(sw & 0xff)])
            out += next.data
            sw = next.sw
            more += 1
        }
        return (out, sw)
    }

    private static func ok(_ sw: UInt16) -> Bool { sw == 0x9000 }
    /// A SELECT or READ BINARY that did what was asked, perhaps with a warning (62xx).
    private static func selected(_ sw: UInt16) -> Bool { ok(sw) || sw & 0xff00 == 0x6200 }
    private static func bytes(_ fid: UInt16) -> [UInt8] { [UInt8(fid >> 8), UInt8(fid & 0xff)] }

    // PKCS #15 ----------------------------------------------------------------------

    private struct Key {
        var label: String
        var id: [UInt8]
        var keyRef: Int
        var canSign: Bool
    }

    private static func key(_ entry: Der.TLV) -> Key? {
        let parts = Der.children(entry.value)
        guard parts.count >= 2 else { return nil }
        let labelBytes = Der.children(parts[0].value).first { [0x0c, 0x13, 0x16].contains($0.tag) }?.value ?? []
        let label = String(decoding: labelBytes, as: UTF8.self).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{0}\u{ff}")))
        var id: [UInt8] = []
        var usage = 0
        var keyRef = -1
        for element in Der.children(parts[1].value) {
            switch element.tag {
            case 0x04: if id.isEmpty { id = element.value }
            case 0x03: usage = Der.bits(element.value)
            case 0x02: if keyRef < 0 { keyRef = Der.uint(element.value) }
            default: break
            }
        }
        if keyRef < 0 {
            // Some cards keep the key reference in the class or the type attributes.
            guard let found = parts.dropFirst(2).lazy.compactMap({ Der.findInteger($0.value) { (0...255).contains($0) } }).first else { return nil }
            keyRef = found
        }
        return Key(label: label, id: id, keyRef: keyRef, canSign: usage & ((1 << 2) | (1 << 3) | (1 << 9)) != 0)
    }

    private struct Path {
        var path: [UInt8]
        var index: Int
        var length: Int
    }

    private static func certificatePath(_ entry: Der.TLV) -> Path? {
        let parts = Der.children(entry.value)
        guard parts.count >= 3,
              let inner = Der.children(parts[2].value).first,
              let pathSequence = Der.children(inner.value).first
        else { return nil }
        return path(pathSequence)
    }

    private static func path(_ t: Der.TLV) -> Path? {
        guard t.tag == 0x30 else { return nil }
        let elements = Der.children(t.value)
        guard let first = elements.first else { return nil }
        if first.tag == 0x30 { return path(first) }
        guard first.tag == 0x04, !first.value.isEmpty else { return nil }
        var index = 0
        var length = 0
        for e in elements.dropFirst() {
            switch e.tag {
            case 0x02: index = Der.uint(e.value)
            case 0x80: length = Der.uint(e.value)
            default: break
            }
        }
        return Path(path: first.value, index: index, length: length)
    }
}

/// The little DER the card's PKCS #15 directory files need.
enum Der {
    struct TLV {
        var tag: UInt8
        var value: [UInt8]
        var headerLength: Int
        var totalLength: Int { headerLength + value.count }
    }

    static func read(_ b: [UInt8], _ offset: Int) -> TLV? {
        guard offset + 2 <= b.count else { return nil }
        var p = offset
        let tag = b[p]
        p += 1
        if tag & 0x1f == 0x1f { return nil }
        var length = Int(b[p])
        p += 1
        if length & 0x80 != 0 {
            let n = length & 0x7f
            guard n > 0, n <= 3, p + n <= b.count else { return nil }
            length = 0
            for _ in 0..<n {
                length = length << 8 | Int(b[p])
                p += 1
            }
        }
        guard p + length <= b.count else { return nil }
        return TLV(tag: tag, value: Array(b[p..<(p + length)]), headerLength: p - offset)
    }

    static func children(_ b: [UInt8]) -> [TLV] {
        var out: [TLV] = []
        var offset = 0
        while offset < b.count, let t = read(b, offset) {
            out.append(t)
            offset += t.totalLength
        }
        return out
    }

    /// The SEQUENCE records at the top, up to the padding (00 or FF).
    static func records(_ b: [UInt8]) -> [TLV] {
        var out: [TLV] = []
        var offset = 0
        while offset < b.count && b[offset] != 0x00 && b[offset] != 0xff {
            guard let t = read(b, offset) else { break }
            if t.tag == 0x30 { out.append(t) }
            offset += t.totalLength
        }
        return out
    }

    /// Where the padding after the last record starts; nil while the records run on.
    static func recordsEnd(_ b: [UInt8]) -> Int? {
        var offset = 0
        while offset < b.count {
            if b[offset] == 0x00 || b[offset] == 0xff { return offset }
            guard let t = read(b, offset) else { return nil }
            offset += t.totalLength
        }
        return nil
    }

    static func firstObject(_ b: [UInt8]) -> [UInt8]? {
        read(b, 0).map { Array(b[0..<$0.totalLength]) }
    }

    static func uint(_ v: [UInt8]) -> Int {
        v.suffix(4).reduce(0) { $0 << 8 | Int($1) }
    }

    /// A BIT STRING's flags, the first named bit being bit 0.
    static func bits(_ v: [UInt8]) -> Int {
        var bits = 0
        for i in 1..<max(1, min(v.count, 5)) {
            for j in 0..<8 where v[i] & (0x80 >> UInt8(j)) != 0 { bits |= 1 << ((i - 1) * 8 + j) }
        }
        return bits
    }

    /// The first INTEGER in a nested structure that `accept` takes.
    static func findInteger(_ b: [UInt8], _ accept: (Int) -> Bool) -> Int? {
        for t in children(b) {
            if t.tag == 0x02 {
                let v = uint(t.value)
                if accept(v) { return v }
            }
            if t.tag & 0x20 != 0, let found = findInteger(t.value, accept) { return found }
        }
        return nil
    }
}
