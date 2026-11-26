package tw.iamreal.app.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import tw.iamreal.app.backend.Backend
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.TapCancel

/**
 * The minimum app version (spec/min-app.md; ADR-0035; #171): what `config` says of this build is read by the core, and a
 * build that can no longer do a card proof, or a field that cannot be read, stops step 2 before the card is read.
 */
class MinAppTest {
    /** 2027-03-01T00:00:00+08:00, in milliseconds. */
    private val on = 1_803_830_400_000L

    private fun config(minApp: String?) =
        ("""{"crl_max_age_days":3,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]""" + (if (minApp == null) "" else ""","min_app":$minApp""") + "}").toByteArray()

    private val bound = """{"android":{"build":12,"from":"2027-03-01"},"ios":{"build":9,"from":"2027-03-01"}}"""

    private class Tapped : RuntimeException()

    private class FakeCard : Card {
        var tapped = false

        override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T {
            tapped = true
            throw Tapped()
        }
    }

    private fun readCard(config: ByteArray, build: Int, nowMs: Long, card: FakeCard): Throwable? {
        val flow = CardProof(object : CardProof.Deps {
            override val backend = Backend("http://127.0.0.1:1", "http://127.0.0.1:1")
            override val card = card
            override fun config() = config
            override fun openSession(): Long = fail("no session before the card is read").let { 0L }
            override fun bundled(name: String): ByteArray = fail("no file before the card is read").let { ByteArray(0) }
            override fun now() = nowMs
            override val appBuild = build
            override val crlNumbers = object : CardProof.CrlNumbers {
                override fun get(issuer: String): String? = null
                override fun set(issuer: String, number: String) {}
            }
        })
        return try {
            flow.readCard(object : CardProof.Events {})
            null
        } catch (e: Throwable) {
            e
        }
    }

    @Test
    fun `what config says of a build`() {
        assertEquals(MinApp.Ok, CardProof.minApp(config(bound), 12, on))
        assertEquals(MinApp.Ok, CardProof.minApp(config(bound), 13, on - 1))
        // The last second before the start date in Taiwan, and its first.
        assertEquals(MinApp.Until("2027-03-01"), CardProof.minApp(config(bound), 11, on - 1000))
        assertEquals(MinApp.TooOld("2027-03-01"), CardProof.minApp(config(bound), 11, on))
        // The app reads the Android entry, not the other app's.
        assertEquals(MinApp.TooOld("2027-03-01"), CardProof.minApp(config(bound), 9, on))
        for (unreadable in listOf(null, "null", "{}", """{"ios":{"build":9,"from":"2027-03-01"}}""", """{"android":{"build":0,"from":"2027-03-01"}}""")) {
            assertEquals(unreadable, MinApp.Unreadable, CardProof.minApp(config(unreadable), 99, on))
        }
    }

    @Test
    fun `a clock the core does not take is the stop of a wrong clock`() {
        val stop = try {
            CardProof.minApp(config(bound), 12, 0L)
            fail("no stop").let { return }
        } catch (e: Stop) {
            e
        }
        assertEquals("clock", stop.code)
    }

    @Test
    fun `a build that can still do a card proof reads the card, before the start date too`() {
        for ((build, now) in listOf(12 to on, 99 to on, 11 to on - 1000)) {
            val card = FakeCard()
            assertTrue("$build", readCard(config(bound), build, now, card) is Tapped)
            assertTrue(card.tapped)
        }
    }

    @Test
    fun `a build older than the minimum from its start date on - step 2 stops before the card is read`() {
        val card = FakeCard()
        val stop = readCard(config(bound), 11, on, card) as? Stop ?: fail("not a stop").let { return }
        assertEquals("min_app", stop.code)
        assertEquals("2027-03-01", stop.values["from"])
        assertFalse("the card was read", card.tapped)
    }

    @Test
    fun `a minimum version that cannot be read - malformed_response, before the card is read`() {
        for (unreadable in listOf(null, """{"android":{"build":"12","from":"2027-03-01"}}""")) {
            val card = FakeCard()
            val stop = readCard(config(unreadable), 99, on, card) as? Stop ?: fail("not a stop").let { return }
            assertEquals("server", stop.code)
            assertEquals("malformed_response", stop.values["code"])
            assertFalse(card.tapped)
        }
    }
}
