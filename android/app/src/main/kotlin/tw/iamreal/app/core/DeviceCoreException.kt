package tw.iamreal.app.core

/**
 * A C function of device-core/ answered with a code other than IDC_OK. It
 * carries the code and nothing else: no value read from a card, a
 * certificate or a list, and no account (device-core/README.md).
 */
class DeviceCoreException(val code: Int) : Exception("device-core: code $code") {
    companion object {
        /** The call itself is wrong: a mistake in the app's code. */
        const val ARGUMENT = 1

        /** The bytes passed in are not what the function reads. */
        const val INPUT = 2

        /** The core failed. */
        const val INTERNAL = 3
    }
}
