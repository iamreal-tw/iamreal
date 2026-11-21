package tw.iamreal.app.flow

/**
 * A member of a JSON object, cut out of the text as it was sent. The core
 * reads the server's `platforms` "as the server sent it"
 * (device-core/include/iamreal_device_core.h, idc_list_consequence): the
 * app hands over the bytes and does not write the value again in its own
 * words.
 */
internal object RawJson {
    /**
     * The bytes of the value of the member [key] of the object that [json] is, or null when [json] is not
     * one object the scan below gets through, has no such member, or has it twice. The scan finds where
     * values begin and end; whether they are JSON the core decides.
     */
    fun member(json: ByteArray, key: String): ByteArray? {
        val s = Scan(json)
        var found: ByteArray? = null
        var count = 0
        s.space()
        if (!s.take('{')) return null
        s.space()
        if (!s.take('}')) {
            while (true) {
                s.space()
                val name = s.string() ?: return null
                s.space()
                if (!s.take(':')) return null
                s.space()
                val from = s.at
                if (!s.value()) return null
                if (name == "\"$key\"") {
                    found = json.copyOfRange(from, s.at)
                    count++
                }
                s.space()
                if (s.take(',')) continue
                if (s.take('}')) break
                return null
            }
        }
        s.space()
        return if (s.at == json.size && count == 1) found else null
    }

    private class Scan(val b: ByteArray) {
        var at = 0

        fun space() {
            while (at < b.size && (b[at] == ' '.code.toByte() || b[at] == '\n'.code.toByte() || b[at] == '\r'.code.toByte() || b[at] == '\t'.code.toByte())) at++
        }

        fun take(c: Char): Boolean = (at < b.size && b[at] == c.code.toByte()).also { if (it) at++ }

        /** A string, with its quotes, as it is written; null when there is none here. */
        fun string(): String? {
            val from = at
            if (!take('"')) return null
            while (at < b.size) {
                when (b[at]) {
                    '\\'.code.toByte() -> at += 2
                    '"'.code.toByte() -> {
                        at++
                        return String(b, from, at - from, Charsets.UTF_8)
                    }
                    else -> at++
                }
            }
            return null
        }

        /** Moves past one value. */
        fun value(): Boolean {
            if (at >= b.size) return false
            if (b[at] == '"'.code.toByte()) return string() != null
            if (b[at] == '{'.code.toByte() || b[at] == '['.code.toByte()) {
                var depth = 0
                while (at < b.size) {
                    when (b[at]) {
                        '"'.code.toByte() -> {
                            if (string() == null) return false
                            continue
                        }
                        '{'.code.toByte(), '['.code.toByte() -> depth++
                        '}'.code.toByte(), ']'.code.toByte() -> {
                            depth--
                            if (depth == 0) {
                                at++
                                return true
                            }
                        }
                    }
                    at++
                }
                return false
            }
            // A number, true, false or null: up to what ends it.
            val from = at
            while (at < b.size && b[at] != ','.code.toByte() && b[at] != '}'.code.toByte() && b[at] != ']'.code.toByte() && b[at] > ' '.code.toByte()) at++
            return at > from
        }
    }
}
