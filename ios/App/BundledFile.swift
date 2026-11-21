import Foundation

/// The files the app carries for computing a proof (ADR-0035): the two
/// circuits, their verification keys and the CRS. They come with the app
/// and are never downloaded; the core checks the SHA-256 of each against
/// the one written in it before using it.
enum BundledFile: String, CaseIterable {
    case circuitRS2048 = "card_proof_rs2048.json"
    case circuitRS4096 = "card_proof_rs4096.json"
    case verificationKeyRS2048 = "card_proof_rs2048.vk"
    case verificationKeyRS4096 = "card_proof_rs4096.vk"
    case crsG1 = "bn254_g1_compressed_2p18.dat"
    case crsG2 = "bn254_g2.dat"

    struct Missing: Error {}

    /// The file's bytes, from the app's bundle.
    func load() throws -> Data {
        guard let url = Bundle.main.url(forResource: rawValue, withExtension: nil) else { throw Missing() }
        return try Data(contentsOf: url)
    }

    /// The four files a proof needs, for a certificate `issuer` issued:
    /// card_proof_rs2048 for G2, card_proof_rs4096 for G3 (spec/issuers.md).
    static func proofFiles(for issuer: String) throws -> DeviceCore.ProofFiles {
        let (circuit, key): (BundledFile, BundledFile)
        switch issuer {
        case "G2": (circuit, key) = (.circuitRS2048, .verificationKeyRS2048)
        case "G3": (circuit, key) = (.circuitRS4096, .verificationKeyRS4096)
        default: throw Missing()
        }
        return DeviceCore.ProofFiles(circuit: try circuit.load(), verificationKey: try key.load(), crsG1: try crsG1.load(), crsG2: try crsG2.load())
    }
}
