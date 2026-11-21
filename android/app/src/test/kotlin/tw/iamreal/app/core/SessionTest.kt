package tw.iamreal.app.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.Base64

/**
 * One card proof in the core, called from Kotlin through the JNI layer on
 * the JVM of this machine: every function of a session, with the
 * certificates, CRLs and signatures of spec/vectors/ (test keys), the files
 * an installer carries, and what the list does (spec/vectors/list-consequence.json).
 */
class SessionTest {
    private fun vectors(name: String) = JSONObject(File(System.getProperty("iamreal.vectors"), name).readText())

    private fun bundled(name: String): ByteArray = System.getProperty("iamreal.bundled").split(File.pathSeparator)
        .map { File(it, name) }.first { it.isFile }.readBytes()

    private fun unhex(s: String): ByteArray = s.removePrefix("0x").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    private fun json(bytes: ByteArray) = JSONObject(String(bytes, Charsets.UTF_8))

    /** A value of a JSON document as JSON text. */
    private fun text(value: Any): String = if (value is String) JSONObject.quote(value) else value.toString()

    /** JSON text with every object's keys in order: two values are the same value when their texts are. */
    private fun canonical(value: Any): String = when (value) {
        is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        is Number -> value.toDouble().toString()
        else -> text(value)
    }

    /** Noon in Taiwan on a date `YYYY-MM-DD`, in seconds since 1970. */
    private fun noon(date: String): Long = java.time.LocalDate.parse(date).toEpochDay() * 86_400 + 4 * 3_600

    /** The first case of circuit-inputs.json in the test roster's scope: what a fake card for the test site would hold. */
    private val inputs = vectors("circuit-inputs.json")
    private val case = inputs.getJSONArray("cases").objects().first { it.getString("scope_string") == String(DeviceCore.scopeString(), Charsets.US_ASCII) }
    private val issuers = JSONArray(inputs.getJSONArray("issuers").objects().map { JSONObject().put("issuer", it.getString("issuer")).put("modulus", it.getString("modulus").removePrefix("0x")) })
    private val certificate = unhex(case.getString("certificate"))
    private val today = case.getLong("current_time").toString().let { "20${it.substring(0, 2)}-${it.substring(2, 4)}-${it.substring(4, 6)}" }
    private val now = noon(today)

    @Test
    fun `a card proof with a card of the vectors gives the card-state request and the record the vectors expect`() {
        val crl = unhex(vectors("revocation-tree.json").getJSONArray("crls").objects().first { it.getString("name") == case.getString("crl") }.getString("crl"))
        val circuit = bundled(case.getString("circuit") + ".json")
        val key = bundled(case.getString("circuit") + ".vk")
        val g1 = bundled("bn254_g1_compressed_2p18.dat")
        val g2 = bundled("bn254_g2.dat")
        val scopeSignature = unhex(case.getString("scope_signature"))
        val codeSignature = unhex(case.getString("declaration_code_signature"))
        // The list and the challenge the card of the vectors signed the declaration code of.
        val declared = vectors("declaration-code.json").getJSONArray("cases").objects().first { it.getString("declaration_code") == case.getString("declaration_code") }

        val session = TestingCore.sessionOpen(issuers.toString().toByteArray())
        try {
            DeviceCore.sessionAddCertificate(session, certificate)
            val checked = json(DeviceCore.sessionCheckCertificates(session, now))
            assertTrue(checked.toString(), checked.getBoolean("ok"))
            assertEquals(case.getString("issuer"), checked.getString("issuer"))

            val sha256 = hex(MessageDigest.getInstance("SHA-256").digest(crl))
            val index = """{"issuer":"${case.getString("issuer")}","crl_number":"1","sha256":"$sha256","root":"${"0".repeat(64)}"}""" + "\n"
            val choice = json(DeviceCore.sessionChooseCrl(session, index.toByteArray()))
            assertTrue(choice.toString(), choice.getBoolean("ok"))
            assertEquals(sha256, choice.getString("sha256"))
            val config = """{"crl_max_age_days":7,"platforms":[]}""".toByteArray()
            val crlChecked = json(DeviceCore.sessionCheckCrl(session, crl, config, null))
            assertTrue(crlChecked.toString(), crlChecked.getBoolean("ok"))
            // A number the device remembers that is higher than the file's: the file is not used.
            assertEquals("crl_rollback", json(DeviceCore.sessionCheckCrl(session, crl, config, "99999999999999999999".toByteArray())).getString("problem"))
            assertTrue(json(DeviceCore.sessionCheckCrl(session, crl, config, crlChecked.getString("highest_after").toByteArray())).getBoolean("ok"))

            // Not before the tree and the files.
            assertEquals(DeviceCoreException.REFUSED, assertThrows(DeviceCoreException::class.java) { DeviceCore.sessionCardStateRequest(session, now, scopeSignature) }.code)
            DeviceCore.sessionBuildTree(session)
            // The files in another order are not the files.
            assertEquals(DeviceCoreException.INPUT, assertThrows(DeviceCoreException::class.java) { DeviceCore.sessionCheckArtifacts(session, key, circuit, g1, g2) }.code)
            DeviceCore.sessionCheckArtifacts(session, circuit, key, g1, g2)
            assertTrue(json(DeviceCore.sessionCheckDate(session, now)).getBoolean("ok"))

            val cardState = json(DeviceCore.sessionCardStateRequest(session, now, scopeSignature))
            assertEquals(case.getString("scope_string"), cardState.getString("scope_string"))
            assertEquals(cardState.getString("scoped_id").substring(0, 10), String(DeviceCore.shortId(cardState.getString("scoped_id").toByteArray())))
            // The other signature is not the card's over the scope string.
            assertEquals(DeviceCoreException.INPUT, assertThrows(DeviceCoreException::class.java) { DeviceCore.sessionCardStateRequest(session, now, codeSignature) }.code)

            // The challenge, dated today in Taiwan.
            val challenge = declared.getString("challenge").toByteArray()
            assertEquals("challenge_malformed", json(DeviceCore.sessionCheckChallenge(session, now, challenge.copyOf(10))).getString("problem"))
            assertEquals("challenge_not_today", json(DeviceCore.sessionCheckChallenge(session, now + 86_400, challenge)).getString("problem"))
            assertTrue(json(DeviceCore.sessionCheckChallenge(session, now, challenge)).getBoolean("ok"))

            val record = json(
                DeviceCore.sessionRecordsRequest(
                    session, circuit, key, g1, g2,
                    declared.getJSONArray("accounts").toString().toByteArray(), declared.getString("challenge").toByteArray(),
                    scopeSignature, codeSignature,
                ),
            )
            assertEquals(cardState.getString("scoped_id"), record.getString("scoped_id"))
            assertEquals(declared.getString("challenge"), record.getString("challenge"))
            assertEquals(canonical(declared.getJSONArray("accounts")), canonical(record.getJSONArray("accounts")))
            assertEquals(case.getString("issuer"), record.getString("issuer"))
            assertEquals(case.getJSONObject("path").getString("smt_root").removePrefix("0x"), record.getString("smt_root"))
            assertEquals(14_656, Base64.getDecoder().decode(record.getString("proof")).size)
        } finally {
            DeviceCore.sessionClose(session)
        }
        // A closed session is no session.
        assertEquals(DeviceCoreException.ARGUMENT, assertThrows(DeviceCoreException::class.java) { DeviceCore.sessionCheckDate(session, now) }.code)
    }

    @Test
    fun `a session the app opens trusts MOICA's keys only`() {
        val session = DeviceCore.sessionOpen()
        try {
            DeviceCore.sessionAddCertificate(session, certificate)
            val checked = json(DeviceCore.sessionCheckCertificates(session, now))
            assertFalse(checked.getBoolean("ok"))
            assertEquals("unknown_issuer", checked.getString("problem"))
        } finally {
            DeviceCore.sessionClose(session)
        }
    }

    @Test
    fun `the card's status for step 4 is what the vectors say, case by case`() {
        val cases = vectors("card-status.json").getJSONArray("cases").objects()
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val name = case.getString("name")
            val call = {
                DeviceCore.cardStatus(
                    text(case.get("platforms")).toByteArray(),
                    text(case.get("card_state")).toByteArray(),
                    text(case.get("known_platforms")).toByteArray(),
                    noon(case.getString("today")),
                )
            }
            val expected = case.getJSONObject("result")
            if (expected.has("rows")) {
                assertEquals(name, canonical(expected), canonical(json(call())))
            } else {
                assertEquals(name, DeviceCoreException.INPUT, assertThrows(name, DeviceCoreException::class.java) { call() }.code)
            }
        }
    }

    @Test
    fun `what a list does is what the vectors say, case by case`() {
        val cases = vectors("list-consequence.json").getJSONArray("cases").objects()
        assertTrue(cases.size > 100)
        for (case in cases) {
            val name = case.getString("name")
            val call = {
                DeviceCore.listConsequence(
                    text(case.get("platforms")).toByteArray(),
                    text(case.get("card_state")).toByteArray(),
                    text(case.get("known_platforms")).toByteArray(),
                    text(case.get("accounts")).toByteArray(),
                    noon(case.getString("today")),
                )
            }
            val expected = case.getJSONObject("result")
            if (expected.has("valid")) {
                assertEquals(name, canonical(expected), canonical(json(call())))
            } else {
                // An answer the device cannot read, or a list for a platform that is not offered.
                assertEquals(name, DeviceCoreException.INPUT, assertThrows(name, DeviceCoreException::class.java) { call() }.code)
            }
        }
    }
}
