package tw.iamreal.app.card

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * The secure channel of second-generation cards against every case of
 * spec/vectors/card-channel.json (spec/card-channel.md). The vectors' key
 * material is made up; the app's own is checked by a real card only.
 */
class SecureChannelTest {
    private val vectors = JSONObject(File(System.getProperty("iamreal.vectors"), "card-channel.json").readText())

    private fun cases(name: String): List<JSONObject> = vectors.getJSONArray(name).let { list -> (0 until list.length()).map { list.getJSONObject(it) } }

    private fun unhex(s: String): ByteArray = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun hex(b: ByteArray?): String? = b?.joinToString("") { "%02x".format(it) }

    private fun JSONObject.hexOrNull(key: String): String? = if (isNull(key)) null else getString(key)

    @Test
    fun `AES-CMAC gives the examples of RFC 4493`() {
        val key = unhex("2b7e151628aed2a6abf7158809cf4f3c")
        val message = unhex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710")
        assertEquals("bb1d6929e95937287fa37d129b756746", hex(SecureChannel.aesCmac(key, ByteArray(0))))
        assertEquals("070a16b46b4d4144f79bdd9dd04a287c", hex(SecureChannel.aesCmac(key, message.copyOf(16))))
        assertEquals("dfa66747de9ae63030ca32611497c827", hex(SecureChannel.aesCmac(key, message.copyOf(40))))
        assertEquals("51f0bebf7e3b9d92fc49741779363cfe", hex(SecureChannel.aesCmac(key, message)))
    }

    @Test
    fun `the card's static keys are diversified from the key material and the card identifier`() {
        for (case in cases("diversify")) {
            val keys = SecureChannel.diversify(unhex(case.getString("card_id")), kek = unhex(case.getString("kek")), masterEnc = unhex(case.getString("master_enc")))
            assertEquals(case.getString("name"), case.getString("k_enc"), hex(keys.enc))
            assertEquals(case.getString("name"), case.getString("k_mac"), hex(keys.mac))
            assertEquals(case.getString("name"), case.getString("k_enc_input"), hex(SecureChannel.diversifyInput(0x04, unhex(case.getString("card_id")))))
            assertEquals(case.getString("name"), case.getString("k_mac_input"), hex(SecureChannel.diversifyInput(0x06, unhex(case.getString("card_id")))))
        }
    }

    @Test
    fun `the card identifier is read from GET DATA tag 45`() {
        for (case in cases("card_id")) {
            assertEquals(case.getString("name"), case.hexOrNull("card_id"), hex(SecureChannel.cardId(unhex(case.getString("response")))))
        }
    }

    @Test
    fun `only 16-byte keys are taken`() {
        for (case in cases("key_information")) {
            assertEquals(case.getString("name"), case.getBoolean("accepted"), SecureChannel.keyInformationAccepted(unhex(case.getString("response"))))
        }
    }

    @Test
    fun `INITIALIZE UPDATE gives the card's challenge and cryptogram, for SCP03 only`() {
        for (case in cases("initialize_update")) {
            val answer = SecureChannel.InitializeUpdate.of(unhex(case.getString("response")))
            if (!case.getBoolean("accepted")) {
                assertNull(case.getString("name"), answer)
                continue
            }
            assertEquals(case.getString("name"), case.getString("card_challenge"), hex(answer!!.cardChallenge))
            assertEquals(case.getString("name"), case.getString("card_cryptogram"), hex(answer.cardCryptogram))
        }
    }

    @Test
    fun `a session is opened only when the card's cryptogram is the expected one`() {
        for (case in cases("session")) {
            val name = case.getString("name")
            val session = SecureChannel.Session.open(
                SecureChannel.StaticKeys(unhex(case.getString("k_enc")), unhex(case.getString("k_mac"))),
                unhex(case.getString("host_challenge")),
                SecureChannel.InitializeUpdate(unhex(case.getString("card_challenge")), unhex(case.getString("card_cryptogram"))),
            )
            if (!case.getBoolean("accepted")) {
                assertNull(name, session)
                continue
            }
            session!!
            assertEquals(name, case.getString("s_enc"), hex(session.sEnc))
            assertEquals(name, case.getString("s_mac"), hex(session.sMac))
            val authenticate = case.getJSONObject("external_authenticate")
            assertEquals(name, authenticate.getString("header"), hex(session.externalAuthenticate.header))
            assertEquals(name, authenticate.getString("body"), hex(session.externalAuthenticate.body))
            assertEquals(name, case.getString("mcv"), hex(session.mcv))
        }
    }

    @Test
    fun `every command of a session counts, with or without data`() {
        val sequence = vectors.getJSONObject("sequence")
        val session = SecureChannel.Session(unhex(sequence.getString("s_enc")), unhex(sequence.getString("s_mac")), unhex(sequence.getString("mcv")))
        val steps = sequence.getJSONArray("steps")
        for (i in 0 until steps.length()) {
            val step = steps.getJSONObject(i)
            val name = step.getString("name")
            val wrapped = session.wrap(step.getInt("cla"), step.getInt("ins"), step.getInt("p1"), step.getInt("p2"), unhex(step.getString("data")), step.getBoolean("encrypt"))
            assertEquals(name, step.getInt("counter"), wrapped.counter)
            assertEquals(name, step.hexOrNull("iv"), hex(wrapped.iv))
            assertEquals(name, step.getString("header"), hex(wrapped.header))
            assertEquals(name, step.getString("body"), hex(wrapped.body))
            assertEquals(name, step.getString("mcv"), hex(session.mcv))
        }
    }

    @Test
    fun `the PIN block is the PIN padded with ff, for 6 to 10 printable ASCII characters`() {
        for (case in cases("pin_block")) {
            val pin = case.getString("pin")
            assertEquals(pin, case.hexOrNull("block"), hex(SecureChannel.pinBlock(pin.toByteArray(Charsets.UTF_8))))
        }
    }

    @Test
    fun `the block to sign is EMSA-PKCS1-v1_5 with SHA-256 for a 2048-bit key`() {
        val case = vectors.getJSONObject("sign_block")
        assertArrayEquals(unhex(case.getString("block")), SecureChannel.signBlock(unhex(case.getString("message"))))
    }

    @Test
    fun `the vectors cover every kind of case`() {
        // A file cut short would pass the loops above with nothing in them.
        assertEquals(listOf(3, 6, 6, 4, 5, 6), listOf("diversify", "card_id", "key_information", "initialize_update", "session", "pin_block").map { cases(it).size })
        assertEquals(9, vectors.getJSONObject("sequence").getJSONArray("steps").length())
    }
}
