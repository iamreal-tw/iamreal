package tw.iamreal.app.core

import tw.iamreal.app.Environment

/**
 * device-core/ (ADR-0034) as Kotlin calls it. Each function is one C
 * function of device-core/include/iamreal_device_core.h, reached through
 * the JNI layer (android/jni/); the roster is always the one this app is
 * built for. The app's code calls the core here and nowhere else.
 *
 * A function may be called from any thread and returns when its work is
 * done. One that fails throws [DeviceCoreException]. The byte arrays
 * passed in stay the caller's: the caller overwrites what must not stay in
 * memory.
 */
object DeviceCore {
    init {
        // Fails when the library's functions are not the ones of the header the JNI layer was built with.
        System.loadLibrary("iamreal_device_core_jni")
    }

    /** Checks that the Barretenberg linked into the library answers and computes the Poseidon2 of spec/scoped-id.md. */
    fun selfCheck() = nativeSelfCheck()

    /** The scope string a card signs first (spec/scope.md): 31 bytes. */
    fun scopeString(): ByteArray = nativeScopeString(Environment.ROSTER)

    /**
     * The declaration code (spec/declaration-code.md) a card signs second: 31 bytes.
     *
     * [accountsJson] is a JSON array of `{"platform":"...","username":"..."}` in ascending order of
     * platform, each platform at most once; [challenge] is the challenge as the server issued it.
     */
    fun declarationCode(accountsJson: ByteArray, challenge: ByteArray): ByteArray =
        nativeDeclarationCode(Environment.ROSTER, accountsJson, challenge)

    private external fun nativeSelfCheck()

    private external fun nativeScopeString(roster: Int): ByteArray

    private external fun nativeDeclarationCode(roster: Int, accountsJson: ByteArray, challenge: ByteArray): ByteArray
}
