package tw.iamreal.app

import android.content.Context
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.CardException
import tw.iamreal.app.card.TapCancel
import tw.iamreal.app.core.DeviceCore

/**
 * What the installers that go out, and a phone on a cable, are wired to:
 * the test site (Environment.kt) and the core's own session, which trusts
 * MOICA's keys only.
 */
internal object Target {
    @Suppress("UNUSED_PARAMETER")
    fun wiring(context: Context) = Wiring(Environment.SITE, Environment.DATA, NoCardReader, DeviceCore::sessionOpen)
}

/**
 * In the card's place until the code that reads a card over NFC is in this
 * repository (issue #163): no card is ever read, so every tap ends as one
 * where no card was held to the phone. No PIN reaches it.
 */
private object NoCardReader : Card {
    override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T = throw CardException(CardException.Reason.NO_TAP)
}
