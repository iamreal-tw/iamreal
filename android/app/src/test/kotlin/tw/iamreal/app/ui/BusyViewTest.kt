package tw.iamreal.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import tw.iamreal.app.backend.ServerException
import tw.iamreal.app.flow.Stop
import java.io.File

/**
 * What the screens say when the server turns a request away as too many (`429` `rate_limited`, `503` `busy`; ADR-0026, #419):
 * on step 3 and step 5, stops.too_many and 再試一次, which sends the same request again; the submission too, not the sentence
 * of a submission that failed. Step 1's sentence (before.busy) is drawn by the screen, above common.next. The sentences are read
 * from design/copy/card-proof.json.
 */
class BusyViewTest {
    private val copy = Copy(File(System.getProperty("iamreal.copy"), "card-proof.json").readText())
    private val messages = Messages(copy)

    private val turnedAway = listOf(ServerException("rate_limited", 429, "0123456789abcdef"), ServerException("busy", 503, "0123456789abcdef"))

    @Test
    fun `the card's state or the challenge turned away - stops too_many, and 再試一次`() {
        for (e in turnedAway) {
            val stop = Stop.server(e)
            assertEquals(e.code, copy.say("stops.too_many"), messages.stop(stop, Messages.At.PIN))
            assertEquals(e.code, copy.say("stops.too_many"), messages.stop(stop, Messages.At.DECLARE))
            assertEquals(e.code, ProgressButton.RETRY, progressButtonAfter(stop))
            assertEquals(e.code, "0123456789abcdef", stop.requestId)
        }
    }

    @Test
    fun `the submission turned away - stops too_many, not that sending failed, and 再試一次`() {
        for (e in turnedAway) {
            val stop = Stop.server(e, "submitting" to "true")
            assertEquals(e.code, copy.say("stops.too_many"), messages.stop(stop, Messages.At.DECLARE))
            assertEquals(e.code, ProgressButton.RETRY, progressButtonAfter(stop))
        }
    }

    @Test
    fun `a 503 that is not busy is not too many people`() {
        val stop = Stop.server(ServerException("unavailable", 503, null))
        assertEquals(copy.say("stops.server_unreadable", "code" to "unavailable"), messages.stop(stop, Messages.At.DECLARE))
        assertEquals(ProgressButton.RESTART, progressButtonAfter(stop))
    }
}
