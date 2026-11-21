import Foundation

/// The highest CRL number this device has accepted for each issuer key
/// (spec/device-checks.md, "Checking the file"): a CRL with a lower number
/// than the last one used is refused. A CRL number is public, and it is
/// the only thing of a card proof the app keeps after it.
protocol CRLNumbers {
    /// The number remembered for `issuer` (G2, G3), in decimal digits.
    func highest(for issuer: String) -> String?
    func remember(_ number: String, for issuer: String)
}

/// The numbers, kept in the app's preferences.
struct StoredCRLNumbers: CRLNumbers {
    private let defaults = UserDefaults.standard

    func highest(for issuer: String) -> String? {
        defaults.string(forKey: "crl-number-\(issuer)")
    }

    func remember(_ number: String, for issuer: String) {
        defaults.set(number, forKey: "crl-number-\(issuer)")
    }
}
