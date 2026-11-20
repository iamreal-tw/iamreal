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
}
