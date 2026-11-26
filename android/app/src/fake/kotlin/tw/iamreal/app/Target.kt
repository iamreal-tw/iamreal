package tw.iamreal.app

import android.content.Context
import tw.iamreal.app.core.TestingCore
import tw.iamreal.app.fake.FakeCard
import tw.iamreal.app.fake.TestSide

/**
 * What the emulator test's build is wired to (README.md, "模擬器上過一次
 * 卡"): the test's server on this machine in the place of the site and of
 * the data domain, a fake card, and a session of the core that trusts the
 * test's issuer keys. This file is in the build type `fake` only; the
 * build of an installer that goes out fails if it finds anything of it
 * (checkApk).
 */
internal object Target {
    fun wiring(context: Context): Wiring {
        val side = TestSide(ORIGIN)
        return Wiring(ORIGIN, ORIGIN, FakeCard(side), openSession = { TestingCore.sessionOpen(side.issuers()) }, appBuild = appBuildOf(context))
    }

    /**
     * Where the test listens, as the emulator reaches it: the test forwards this port of the emulator to
     * its own server (`adb reverse`).
     */
    private const val ORIGIN = "http://127.0.0.1:18169"
}
