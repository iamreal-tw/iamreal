package tw.iamreal.app

import android.content.Context
import android.nfc.NfcAdapter
import tw.iamreal.app.card.NfcCard
import tw.iamreal.app.core.DeviceCore

/**
 * What the installers that go out, and a phone on a cable, are wired to:
 * the test site (Environment.kt), the card over the phone's NFC, and the
 * core's own session, which trusts MOICA's keys only.
 */
internal object Target {
    fun wiring(context: Context): Wiring {
        val card = NfcCard(NfcAdapter.getDefaultAdapter(context))
        return Wiring(Environment.SITE, Environment.DATA, card, DeviceCore::sessionOpen, card)
    }
}
