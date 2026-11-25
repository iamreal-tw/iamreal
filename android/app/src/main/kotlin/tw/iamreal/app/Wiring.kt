package tw.iamreal.app

import android.app.Activity
import tw.iamreal.app.card.Card

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
    /** Told when the app's screen comes to the front and leaves it: a card is read only in between. */
    val front: Front? = null,
) {
    interface Front {
        fun resumed(activity: Activity)

        fun paused(activity: Activity)
    }

    /** The site as links on the screen write it: without the scheme. */
    val domain: String get() = site.substringAfter("://")
}
