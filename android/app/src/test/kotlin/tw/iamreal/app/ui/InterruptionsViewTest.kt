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
    fun `no card sensed - how to look for the place again, and nothing about holding the card still`() {
        val none = card(CardException.Reason.NO_TAP)
        assertEquals("沒有感應到卡片。請再感應一次：把卡片平貼在手機背面，沒有反應就慢慢上下移動卡片，畫面變成「讀取中」就停住。", messages.stop(none, Messages.At.READ))
        assertEquals(ReadButton.TAP_AGAIN, readButtonAfter(none))
    }

    @Test
    fun `where a card is looked for the app's sentences never say not to move it`() {
        // The rule (design/copy/card-proof.md, after step 2): moving the card is how its place is found; it is kept still once the
        // screen says it is being read. So "不要移動" only where the sentence is about that moment.
        val still = "不要移動"
        for (key in listOf("app_read.how_android", "app_panel.android_wait", "app_demo.sense_android", "app_stops.no_tap_android")) {
            assertEquals("$key says not to move the card", false, copy.say(key).contains(still))
        }
        val reading = copy.say("app_panel.android_busy_title")
        for (key in listOf("app_panel.reading", "app_panel.signing")) assertEquals(key, true, copy.say(key).contains(still))
        assertEquals("app_stops.read_dropped_android ties it to the screen saying so", true, copy.say("app_stops.read_dropped_android").contains("「$reading」之後$still"))
    }

    @Test
    fun `a card that left - each step's own sentence, and the tap again`() {
        val left = card(CardException.Reason.DROPPED)
        // Android's own: the card is kept still once the screen says it is being read, not while it is looked for.
        assertEquals("卡片在讀取途中離開了手機。請再感應一次；畫面變成「讀取中」之後不要移動卡片，直到畫面說可以拿開。", messages.stop(left, Messages.At.READ))
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
