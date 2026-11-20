import Foundation

/// What the screen of the shell shows: that the core is linked and
/// answers. Each value is what a function of the core returned.
struct CoreReport: Equatable {
    /// idc_abi_version(), and whether it is the header's IDC_ABI_VERSION.
    let abiVersion: UInt32
    let abiVersionMatches: Bool
    /// idc_self_check(): 0 is IDC_OK.
    let selfCheck: Int32
    /// idc_scope_string() for the roster of this build; nil when it failed.
    let scopeString: String?
    /// How many of the bundled files could be read, of how many.
    let bundledFiles: Int
    let bundledFilesExpected: Int

    /// Calls the core. Takes as long as Barretenberg takes to start.
    static func make() -> CoreReport {
        let selfCheck: Int32
        do {
            try DeviceCore.selfCheck()
            selfCheck = IDC_OK
        } catch let failure as DeviceCore.Failure {
            selfCheck = failure.code
        } catch {
            selfCheck = IDC_ERR_INTERNAL
        }
        let scope = try? DeviceCore.scopeString(AppEnvironment.roster)
        return CoreReport(
            abiVersion: DeviceCore.linkedABIVersion,
            abiVersionMatches: DeviceCore.linkedABIVersion == DeviceCore.headerABIVersion,
            selfCheck: selfCheck,
            scopeString: scope.flatMap { String(data: $0, encoding: .utf8) },
            bundledFiles: BundledFile.allCases.filter { (try? $0.load()) != nil }.count,
            bundledFilesExpected: BundledFile.allCases.count)
    }
}
