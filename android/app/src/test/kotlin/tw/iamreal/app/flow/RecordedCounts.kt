package tw.iamreal.app.flow

import org.json.JSONObject

/** Counts whose requests are kept here, read back as JSON, in the order they were sent; the store is in memory. */
class RecordedCounts(
    var nowMs: Long = 1_800_000_000_000L,
    var stored: String? = null,
    private val osVersion: String = "14",
    private val appVersion: String = "2026.11.5",
    private val model: String = "SM-S918B",
    private val sendFails: Boolean = false,
    /** The random source's bytes, every time; by default each ID is told apart from the one before. */
    private val random: ByteArray? = null,
) {
    val sent = mutableListOf<JSONObject>()
    private var next = 0

    val counts = Counts(object : Counts.Deps {
        override fun send(body: ByteArray) {
            synchronized(sent) { sent += JSONObject(String(body, Charsets.UTF_8)) }
            if (sendFails) throw IllegalStateException("no network")
        }

        override fun now() = nowMs

        // Not random: each ID is told apart from the one before.
        override fun random(bytes: ByteArray) {
            val given = random
            if (given != null) return given.copyInto(bytes).let {}
            next++
            bytes.fill(next.toByte())
        }

        override val store = object : Counts.Store {
            override fun get() = stored

            override fun set(value: String) {
                stored = value
            }
        }
        override val client = "android"
        override val osVersion = this@RecordedCounts.osVersion
        override val appVersion = this@RecordedCounts.appVersion
        override val model = this@RecordedCounts.model
    })

    /** What each count said happened: `step:read`, `stop:no_nfc`, `retry:no_tap`, `action:tap_dropped:1`, `duration:crl:lt_1s`. */
    fun events(): List<String> = synchronized(sent) {
        sent.map {
            when (val event = it.getString("event")) {
                "step" -> "step:${it.getString("step")}"
                "stop", "retry" -> "$event:${it.getString("reason")}"
                "action" -> "action:${it.getString("action")}" + (if (it.has("tap")) ":${it.getString("tap")}" else "")
                else -> "duration:${it.getString("step")}:${it.getString("took")}"
            }
        }
    }
}
