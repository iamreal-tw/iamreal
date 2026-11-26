package tw.iamreal.app

import android.content.Context
import androidx.core.content.pm.PackageInfoCompat
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.ReadsInFront

/**
 * What the card proof is wired to. Target.kt of the build says which: the
 * installers that go out and a phone on a cable get the test site, a real
 * card and the core's own session (src/real/); the emulator test gets a
 * server on this machine, a fake card and a session that trusts the test's
 * issuer keys (src/fake/). Nothing in the app or from a server changes it.
 */
internal class Wiring(
    /** The site the app talks to (ADR-0028), without a slash at the end. */
    val site: String,
    /** Where the CRL archive is (ADR-0027). */
    val data: String,
    val card: Card,
    /** Opens a session of the core. */
    val openSession: () -> Long,
    /** The app's own build, the store's integer version number (`versionCode`): what the minimum app version is compared with (spec/min-app.md). */
    val appBuild: Int,
    /** Told when the app's screen comes to the front and leaves it: a card is read only in between. */
    val front: ReadsInFront? = null,
) {
    /** The site as links on the screen write it: without the scheme. */
    val domain: String get() = site.substringAfter("://")
}

/** The installed app's own `versionCode`, as the system has it. */
internal fun appBuildOf(context: Context): Int =
    PackageInfoCompat.getLongVersionCode(context.packageManager.getPackageInfo(context.packageName, 0)).toInt()
