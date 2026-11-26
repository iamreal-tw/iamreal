package tw.iamreal.app.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import tw.iamreal.app.backend.Backend
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.TapCancel

/**
 * The operator stopped taking card proofs (docs/api/card-proof.md, `paused`; #394): when `config` says so on the way, step 2
 * stops before the card is read. Against a fake back end: the config the flow is given is written here.
 */
class PausedTest {
    private val platforms = """"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"""

    private fun config(paused: String?) =
        ("{" + (if (paused == null) "" else """"paused":$paused,""") + """"crl_max_age_days":3,$platforms,"min_app":{"android":{"build":1,"from":"2026-11-20"}}}""").toByteArray()

    /** The card the flow would read: it says it was tapped, and goes no further. */
    private class Tapped : RuntimeException()

    private class FakeCard : Card {
        var tapped = false

        override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T {
            tapped = true
            throw Tapped()
        }
    }

    private fun readCard(config: ByteArray, card: FakeCard, items: MutableList<CardProof.Item>): Throwable? {
        val flow = CardProof(object : CardProof.Deps {
            override val backend = Backend("http://127.0.0.1:1", "http://127.0.0.1:1")
            override val card = card
            override fun config() = config
            override fun openSession(): Long = fail("no session before the card is read").let { 0L }
            override fun bundled(name: String): ByteArray = fail("no file before the card is read").let { ByteArray(0) }
            // A moment the core takes (2027): the minimum app version is read before the card too.
            override fun now() = 1_800_000_000_000L
            override val appBuild = 1
            override val crlNumbers = object : CardProof.CrlNumbers {
                override fun get(issuer: String): String? = null
                override fun set(issuer: String, number: String) {}
            }
            override val counts = RecordedCounts().counts
            override val attempt = counts.attempt()
        })
        return try {
            flow.readCard(object : CardProof.Events {
                override fun done(item: CardProof.Item) {
                    items += item
                }
            })
            null
        } catch (e: Throwable) {
            e
        }
    }

    @Test
    fun `config's paused, read`() {
        assertEquals(true, CardProof.pausedIn(config("true")))
        assertEquals(false, CardProof.pausedIn(config("false")))
        assertEquals(false, CardProof.pausedIn(config(null)))
        // There and neither true nor false (spec/device-checks.md).
        for (other in listOf("1", "\"true\"", "null")) assertNull(other, CardProof.pausedIn(config(other)))
    }

    @Test
    fun `config says paused - step 2 stops with paused before the card is read`() {
        val card = FakeCard()
        val items = mutableListOf<CardProof.Item>()
        val stop = readCard(config("true"), card, items) as? Stop ?: fail("not a stop").let { return }
        assertEquals("server", stop.code)
        assertEquals("paused", stop.values["code"])
        assertFalse("the card was read", card.tapped)
        assertTrue("連上島民證明的伺服器 was done", items.isEmpty())
    }

    @Test
    fun `config says not paused, or nothing of it - the card is read`() {
        for (paused in listOf("false", null)) {
            val card = FakeCard()
            val items = mutableListOf<CardProof.Item>()
            assertTrue("$paused", readCard(config(paused), card, items) is Tapped)
            assertTrue("$paused", card.tapped)
            assertEquals(listOf(CardProof.Item.SERVER), items)
        }
    }

    @Test
    fun `config's paused neither true nor false - malformed_response`() {
        val card = FakeCard()
        val stop = readCard(config("\"yes\""), card, mutableListOf()) as? Stop ?: fail("not a stop").let { return }
        assertEquals("malformed_response", stop.values["code"])
        assertFalse(card.tapped)
    }
}
