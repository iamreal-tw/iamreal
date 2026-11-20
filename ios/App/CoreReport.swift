import Foundation

/// What the screen of the shell shows: that the core is linked and
/// answers. Each value is what a function of the core returned.
struct CoreReport: Equatable {
    /// idc_abi_version().
    let abiVersion: UInt32
    /// What idc_self_check() did: nil when Barretenberg answered.
    let selfCheckFailure: DeviceCore.Failure?
    /// idc_scope_string() for the roster of this build; nil when it failed.
    let scopeString: String?

    /// Calls the core. Takes as long as Barretenberg takes to start.
    static func make() -> CoreReport {
        var failure: DeviceCore.Failure?
        do {
            try DeviceCore.selfCheck()
        } catch let thrown as DeviceCore.Failure {
            failure = thrown
        } catch {
            failure = DeviceCore.Failure(code: IDC_ERR_INTERNAL)
        }
        let scope = try? DeviceCore.scopeString(AppEnvironment.roster)
        return CoreReport(
            abiVersion: DeviceCore.linkedABIVersion,
            selfCheckFailure: failure,
            scopeString: scope.flatMap { String(data: $0, encoding: .utf8) })
    }
}
