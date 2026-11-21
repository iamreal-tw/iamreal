package tw.iamreal.app.core

import tw.iamreal.app.Environment

/**
 * For tests only: the one function the library of the tests has besides
 * those of [DeviceCore] (android/build-native.sh, "test-issuers"). This file is
 * compiled into the build type `fake` and the unit tests, and into no
 * installer that goes out (app/build.gradle.kts).
 */
object TestingCore {
    /**
     * Opens a session as [DeviceCore.sessionOpen] does, but one that checks certificates and CRLs against
     * the issuer keys given in place of MOICA's: how a fake card, whose certificate a test key issued,
     * gets past the first check. [issuersJson] is a JSON array of `{"issuer":"G2","modulus":"<hex>"}`.
     */
    fun sessionOpen(issuersJson: ByteArray): Long {
        // The library is loaded by DeviceCore.
        DeviceCore.selfCheck()
        return nativeSessionOpen(Environment.ROSTER, issuersJson)
    }

    private external fun nativeSessionOpen(roster: Int, issuersJson: ByteArray): Long
}
