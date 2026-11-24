package tw.iamreal.app.flow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The server's answer to a submission as the app holds it
 * ([CardProof.Answer]), read by the core: every case of
 * spec/vectors/records-response.json, the file web/ and device-core/ read.
 */
class AnswerTest {
    private val cases = JSONObject(File(System.getProperty("iamreal.vectors"), "records-response.json").readText()).getJSONArray("cases")
        .let { list -> (0 until list.length()).map { list.getJSONObject(it) } }

    private fun strings(list: JSONArray) = (0 until list.length()).map { list.getString(it) }

    @Test
    fun `the answer is what the vectors say, case by case`() {
        assertTrue(cases.size >= 91)
        for (case in cases) {
            val name = case.getString("name")
            val expected = case.getJSONObject("result")
            val answer = CardProof.Answer.of(case.getString("body").toByteArray(), case.getJSONArray("rows").toString().toByteArray())
            assertEquals(name, if (expected.isNull("seq")) null else expected.getLong("seq"), answer.seq)
            assertEquals(name, if (expected.isNull("record_hash")) null else expected.getString("record_hash"), answer.recordHash)
            assertEquals(name, if (expected.isNull("ordinal")) null else expected.getLong("ordinal"), answer.ordinal)
            assertEquals(name, strings(expected.getJSONArray("mismatches")), answer.mismatches)
            if (expected.isNull("kinds")) {
                assertNull(name, answer.kinds)
                continue
            }
            val kinds = expected.getJSONArray("kinds")
            val written = (0 until kinds.length()).map { kinds.getJSONObject(it) }.map {
                listOf(it.getString("platform"), it.getString("kind"), it.getString("username"), if (it.isNull("account_cards")) null else it.getLong("account_cards"))
            }
            assertEquals(name, written, answer.kinds!!.map { listOf(it.platform, it.kind, it.username, it.accountCards) })
        }
    }

    @Test
    fun `rows the core does not take are an answer with nothing told, not a failure`() {
        val body = cases.first { !it.getJSONObject("result").isNull("kinds") }.getString("body").toByteArray()
        val answer = CardProof.Answer.of(body, "not rows".toByteArray())
        assertEquals(listOf(null, null, null, null, emptyList<String>()), listOf(answer.seq, answer.recordHash, answer.ordinal, answer.kinds, answer.mismatches))
    }
}
