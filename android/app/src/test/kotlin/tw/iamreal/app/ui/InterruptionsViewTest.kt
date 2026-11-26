package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import tw.iamreal.app.card.CardException
import tw.iamreal.app.flow.Stop
import java.io.File

/**
 * Which sentence and which button a tap that did not go through gets (issue #171; design/copy/card-proof.md, the app's stops of
 * steps 2, 3 and 5). The sentences are read from design/copy/card-proof.json.
 */
class InterruptionsViewTest {
    private val copy = Copy(File(System.getProperty("iamreal.copy"), "card-proof.json").readText())
    private val messages = Messages(copy)

    private fun card(reason: CardException.Reason) = Stop("card", mapOf("reason" to reason.name))

    @Test
    fun `a card that left - each step's own sentence, and the tap again`() {
        val left = card(CardException.Reason.DROPPED)
        assertEquals(copy.say("app_stops.read_dropped"), messages.stop(left, Messages.At.READ))
        assertEquals(copy.say("app_stops.dropped_pin_kept"), messages.stop(left, Messages.At.PIN))
        assertEquals(copy.say("app_stops.dropped"), messages.stop(left, Messages.At.DECLARE))
        assertEquals(ReadButton.TAP_AGAIN, readButtonAfter(left))
        assertEquals(ProgressButton.TAP_AGAIN, progressButtonAfter(left))
    }

    @Test
    fun `NFC turned off - step 2 names its button, a later tap is made again`() {
        val off = card(CardException.Reason.NFC_OFF)
        assertEquals(copy.say("app_stops.nfc_off"), messages.stop(off, Messages.At.READ))
        assertEquals(copy.say("app_stops.nfc_off_tap"), messages.stop(off, Messages.At.PIN))
        assertEquals(copy.say("app_stops.nfc_off_tap"), messages.stop(off, Messages.At.DECLARE))
        assertEquals(ReadButton.NFC, readButtonAfter(off))
        assertEquals(ProgressButton.TAP_AGAIN, progressButtonAfter(off))
    }

    @Test
    fun `the PIN on its way, a wrong PIN, another card`() {
        assertEquals(copy.say("app_stops.pin_maybe_received"), messages.stop(card(CardException.Reason.PIN_MAYBE_SENT), Messages.At.PIN))
        assertEquals(copy.say("pin.pin_incorrect"), messages.stop(card(CardException.Reason.PIN_INCORRECT), Messages.At.PIN))
        assertEquals(ProgressButton.RESTART, progressButtonAfter(card(CardException.Reason.PIN_INCORRECT)))
        assertEquals(copy.say("app_stops.other_card"), messages.stop(Stop("other_card"), Messages.At.PIN))
        assertEquals(copy.say("app_stops.other_card_declare"), messages.stop(Stop("other_card"), Messages.At.DECLARE))
        assertEquals(ProgressButton.TAP_AGAIN, progressButtonAfter(Stop("other_card")))
    }

    @Test
    fun `a config that cannot be read, a server that does not answer - the web page's sentence, and a new card proof`() {
        for (code in listOf("malformed_response", "network")) {
            val stop = Stop("server", mapOf("code" to code))
            assertEquals(copy.say("stops.server_unreadable", "code" to code), messages.stop(stop, Messages.At.READ))
            assertEquals(ReadButton.RESTART, readButtonAfter(stop))
        }
    }
}
