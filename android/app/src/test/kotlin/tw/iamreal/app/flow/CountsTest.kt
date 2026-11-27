package tw.iamreal.app.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.iamreal.app.backend.Backend
import tw.iamreal.app.card.Card
import tw.iamreal.app.card.CardConnection
import tw.iamreal.app.card.CardException
import tw.iamreal.app.card.TapCancel
import tw.iamreal.app.core.DeviceCore
import java.time.Instant

/**
 * The counts of the app's card proofs (spec/counts.md; ADR-0039): the card proof device ID and its 31 days, what a count
 * carries and does not, the reason of every stop, and what the flow sends when a step stops on the way. The bodies are
 * the core's (`idc_count`), so each one here is one the server takes.
 */
class CountsTest {
    private fun at(iso: String) = Instant.parse(iso).toEpochMilli()

    // The card proof device ID ---------------------------------------------------------

    @Test
    fun `the device ID is made once, and kept for 31 days from the date it was made on in Taiwan`() {
        // 23:30 in Taiwan on 2027-01-01.
        val r = RecordedCounts(nowMs = at("2027-01-01T15:30:00Z"))
        val id = r.counts.deviceId()
        assertTrue(Regex("[0-9a-f]{32}").matches(id))
        assertEquals("$id.2027-01-01", r.stored)
        r.nowMs = at("2027-01-31T15:59:59Z") // 2027-01-31 in Taiwan: day 30
        assertEquals(id, r.counts.deviceId())
        r.nowMs = at("2027-01-31T16:00:00Z") // 2027-02-01 in Taiwan: day 31
        val next = r.counts.deviceId()
        assertNotEquals(id, next)
        // The old one is not kept anywhere.
        assertEquals("$next.2027-02-01", r.stored)
        assertFalse(r.stored!!.contains(id))
    }

    @Test
    fun `a stored device ID that cannot be read, or is dated after today, is replaced`() {
        for (stored in listOf("", "x", "0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789ABCDEF.2027-01-01", "0123456789abcdef0123456789abcdef.2027-02-30", "0123456789abcdef0123456789abcdef.2027-01-02")) {
            val r = RecordedCounts(nowMs = at("2027-01-01T04:00:00Z"), stored = stored)
            val id = r.counts.deviceId()
            assertNotEquals(stored, id)
            assertEquals(stored, "$id.2027-01-01", r.stored)
        }
    }

    // What a count carries -------------------------------------------------------------

    @Test
    fun `a count carries the client, the two IDs, the versions and the model, and nothing else`() {
        val r = RecordedCounts()
        val attempt = r.counts.attempt()
        attempt.step("read")
        val count = r.sent.last()
        assertEquals(
            setOf("client", "event", "step", "device_id", "attempt_id", "os_version", "app_version", "model"),
            count.keys().asSequence().toSet(),
        )
        assertEquals("android", count.getString("client"))
        assertEquals(r.counts.deviceId(), count.getString("device_id"))
        assertNotEquals(count.getString("device_id"), count.getString("attempt_id"))
        assertEquals("14", count.getString("os_version"))
        assertEquals("2026.11.5", count.getString("app_version"))
        assertEquals("SM-S918B", count.getString("model"))
        // Each card proof its own attempt ID; the device ID is the same.
        r.counts.attempt().step("read")
        assertNotEquals(count.getString("attempt_id"), r.sent.last().getString("attempt_id"))
        assertEquals(count.getString("device_id"), r.sent.last().getString("device_id"))
    }

    @Test
    fun `a version or a model not in its format is left out, not rewritten`() {
        val r = RecordedCounts(osVersion = "VanillaIceCream", appVersion = "dev", model = "Alice’s phone")
        r.counts.attempt().step("open")
        val count = r.sent.single()
        for (member in listOf("os_version", "app_version", "model")) assertFalse(member, count.has(member))
        assertEquals("open", count.getString("step"))
    }

    @Test
    fun `each step once, nothing after a stop, and a code of the server the table has not is server_other`() {
        val r = RecordedCounts()
        val attempt = r.counts.attempt()
        attempt.step("read")
        attempt.step("read")
        attempt.retry("no_tap")
        attempt.tapDropped(2)
        attempt.took("tree", 12_345)
        attempt.retry("server_http_502")
        attempt.stop("server_teapot")
        attempt.step("certificates")
        attempt.stop("engine")
        attempt.retry("no_tap")
        assertEquals(
            listOf("step:read", "retry:no_tap", "action:tap_dropped:2", "duration:tree:10s_30s", "retry:server_other", "stop:server_other"),
            r.events(),
        )
    }

    @Test
    fun `a count that cannot be sent holds nothing up`() {
        val r = RecordedCounts(sendFails = true)
        val attempt = r.counts.attempt()
        attempt.step("read")
        attempt.stop("no_nfc")
        assertEquals(listOf("step:read", "stop:no_nfc"), r.events())
    }

    // The reason of every stop ---------------------------------------------------------

    @Test
    fun `every stop the flow makes has a reason the server takes from an app, or none`() {
        val stops = CardException.Reason.entries.map { Stop("card", mapOf("reason" to it.name)) } +
            listOf("no_certificate", "expired", "not_yet_valid", "not_citizen_primary", "unsupported_format", "unknown_issuer", "ambiguous_certificate")
                .map { Stop("certificate", mapOf("problem" to it, "date" to "2027-01-01")) } +
            listOf("crl_unavailable", "crl_hash", "crl_unusable", "crl_rollback", "crl_stale").map { Stop("crl", mapOf("code" to it, "days" to "9")) } +
            listOf("network", "malformed_response", "paused", "busy", "rate_limited", "internal", "crl_stale", "challenge_unknown", "challenge_used", "challenge_attempts", "proof", "root", "date_order", "empty", "switch_limit", "daily_limit", "malformed", "scope", "platform", "challenge_malformed")
                .map { Stop("server", mapOf("code" to it), "req-1") } +
            listOf("other_card", "revoked", "card_signature", "artifact", "engine", "date_mismatch", "date_changed", "idle", "clock", "state").map { Stop(it) } +
            Stop("min_app", mapOf("from" to "2027-03-01"))
        for (stop in stops) {
            val reason = Counts.reasonOf(stop)
            if (stop.code == "card" && stop.values["reason"] == CardException.Reason.DROPPED.name) {
                assertNull("a card that left is an action", reason)
                continue
            }
            assertNotNull("${stop.code} ${stop.values}", reason)
            // A code of the table for an app: the core builds the body, which it does only for a count the server takes.
            DeviceCore.count("""{"client":"android","event":"stop","reason":"$reason","device_id":"${"1".repeat(32)}","attempt_id":"${"2".repeat(32)}"}""".toByteArray())
        }
        assertEquals("server_paused", Counts.reasonOf(Stop("server", mapOf("code" to "paused"))))
        assertEquals("challenge_not_today", Counts.reasonOf(Stop("date_mismatch")))
        assertEquals("app_too_old", Counts.reasonOf(Stop("min_app", mapOf("from" to "2027-03-01"))))
        assertEquals("cert_expired", Counts.reasonOf(Stop("certificate", mapOf("problem" to "expired", "date" to "2027-01-01"))))
        assertEquals("pin_maybe_received", Counts.reasonOf(Stop("card", mapOf("reason" to "PIN_MAYBE_SENT"))))
        assertNull("the cardholder left", Counts.reasonOf(Stop("cancelled")))
        assertEquals("blocked_switch_limit", Counts.reasonOf(Blocked("switch_limit", "threads")))
        assertEquals("username", Counts.reasonOf(Blocked("username", "threads")))
    }

    // What the flow sends --------------------------------------------------------------

    private val platforms = """"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"""
    private val config = """{"crl_max_age_days":3,$platforms,"min_app":{"android":{"build":1,"from":"2026-11-20"}}}""".toByteArray()

    /** A card whose every tap fails for [reason]. */
    private class FailingCard(private val reason: CardException.Reason) : Card {
        override fun <T> tap(cancel: TapCancel, use: (CardConnection) -> T): T = throw CardException(reason)
    }

    private fun flow(r: RecordedCounts, card: Card, config: () -> ByteArray = { this.config }) = CardProof(object : CardProof.Deps {
        override val backend = Backend("http://127.0.0.1:1", "http://127.0.0.1:1")
        override val card = card
        override fun config() = config()
        override fun openSession(): Long = throw AssertionError("no session before the card is read")
        override fun bundled(name: String): ByteArray = throw AssertionError("no file before the card is read")
        override fun now() = r.nowMs
        override val appBuild = 1
        override val crlNumbers = object : CardProof.CrlNumbers {
            override fun get(issuer: String): String? = null
            override fun set(issuer: String, number: String) {}
        }
        override val counts = r.counts
        override val attempt = r.counts.attempt()
    })

    private fun readCard(f: CardProof): Stop = assertThrows(Stop::class.java) { f.readCard(object : CardProof.Events {}) }

    @Test
    fun `step 2's tap - what is tried again on the same card proof, what ends it, and a card that left`() {
        val cases = mapOf(
            CardException.Reason.NO_TAP to listOf("retry:no_tap"),
            CardException.Reason.NFC_OFF to listOf("retry:nfc_off"),
            CardException.Reason.CANCELLED to listOf("retry:tap_cancelled"),
            CardException.Reason.DROPPED to listOf("action:tap_dropped:1"),
            CardException.Reason.NO_NFC to listOf("stop:no_nfc"),
            CardException.Reason.FIRST_GENERATION to listOf("stop:first_generation"),
            CardException.Reason.OTHER to listOf("stop:card_error"),
        )
        for ((reason, then) in cases) {
            val r = RecordedCounts()
            val f = flow(r, FailingCard(reason))
            readCard(f)
            assertEquals(reason.name, listOf("step:read", "step:config") + then, r.events())
            // Tried again on the same card proof: the steps already sent are not sent again.
            if (then.single().startsWith("retry") || then.single().startsWith("action")) {
                readCard(f)
                assertEquals(reason.name, listOf("step:read", "step:config") + then + then, r.events())
            }
        }
    }

    @Test
    fun `step 2 before the tap - the server stopped taking card proofs, or did not answer`() {
        val paused = RecordedCounts()
        readCard(flow(paused, FailingCard(CardException.Reason.NO_TAP)) { """{"paused":true,$platforms}""".toByteArray() })
        assertEquals(listOf("step:read", "stop:server_paused"), paused.events())

        val silent = RecordedCounts()
        readCard(flow(silent, FailingCard(CardException.Reason.NO_TAP)) { throw tw.iamreal.app.backend.ServerException(Backend.NETWORK, 0, null) })
        assertEquals(listOf("step:read", "stop:server_network"), silent.events())

        val old = RecordedCounts()
        readCard(flow(old, FailingCard(CardException.Reason.NO_TAP)) { """{$platforms,"min_app":{"android":{"build":2,"from":"2026-11-20"}}}""".toByteArray() })
        // The server answered its config; this build is too old by it.
        assertEquals(listOf("step:read", "step:config", "stop:app_too_old"), old.events())
    }

    @Test
    fun `the screen ends a card proof - the PIN waited too long`() {
        val r = RecordedCounts()
        val f = flow(r, FailingCard(CardException.Reason.NO_TAP))
        f.end(Stop("idle"))
        // Ended once: what the screen says after it is not counted again.
        f.end(Stop("engine"))
        assertEquals(listOf("stop:idle"), r.events())
    }

    @Test
    fun `counts that cannot be sent change nothing of the card proof`() {
        for (reason in listOf(CardException.Reason.NO_TAP, CardException.Reason.NO_NFC)) {
            val quiet = RecordedCounts()
            val failing = RecordedCounts(sendFails = true)
            val a = readCard(flow(quiet, FailingCard(reason)))
            val b = readCard(flow(failing, FailingCard(reason)))
            assertEquals(a.code, b.code)
            assertEquals(a.values, b.values)
            assertEquals(quiet.events(), failing.events())
        }
    }

    @Test
    fun `the device ID is the core's, by the vectors' rule`() {
        val vectors = org.json.JSONObject(java.io.File(System.getProperty("iamreal.vectors"), "counts.json").readText()).getJSONArray("device_ids")
        for (i in 0 until vectors.length()) {
            val d = vectors.getJSONObject(i)
            val stored = if (d.isNull("stored")) null else d.getString("stored")
            val hex = d.getString("random")
            val r = RecordedCounts(nowMs = d.getLong("now") * 1000, stored = stored, random = ByteArray(16) { hex.substring(2 * it, 2 * it + 2).toInt(16).toByte() })
            assertEquals(d.getString("name"), d.getString("device_id"), r.counts.deviceId())
            assertEquals(d.getString("name"), if (d.isNull("store")) stored else d.getString("store"), r.stored)
        }
    }

    @Test
    fun `the submission carries the card proof device ID`() {
        val id = "0123456789abcdef0123456789abcdef"
        assertEquals("""{"device_id":"$id","scoped_id":"x"}""", String(CardProof.withDeviceId("""{"scoped_id":"x"}""".toByteArray(), id)))
        assertThrows(IllegalArgumentException::class.java) { CardProof.withDeviceId("[]".toByteArray(), id) }
        assertThrows(IllegalArgumentException::class.java) { CardProof.withDeviceId("{}".toByteArray(), id) }
        assertThrows(IllegalArgumentException::class.java) { CardProof.withDeviceId("{\"a\":1}".toByteArray(), "x") }
    }
}
