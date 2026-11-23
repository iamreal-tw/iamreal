package tw.iamreal.app.core

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Kotlin calling device-core/ through the JNI layer, on the JVM of this
 * machine. The answers are the ones of spec/vectors/, read from there.
 */
class DeviceCoreTest {
    private fun vectors(name: String) = JSONObject(File(System.getProperty("iamreal.vectors"), name).readText())

    @Test
    fun `the scope string is the one of the test log`() {
        val scopes = vectors("scope.json").getJSONArray("scopes")
        val test = (0 until scopes.length()).map { scopes.getJSONObject(it) }
            .single { it.getString("proof_log") == "test" && it.getBoolean("accepted") }
        assertEquals(test.getString("scope_string"), String(DeviceCore.scopeString(), Charsets.US_ASCII))
    }

    @Test
    fun `the core answers its self check`() {
        DeviceCore.selfCheck()
    }

    @Test
    fun `the declaration codes are the ones of the cases in the test scope`() {
        val testScope = String(DeviceCore.scopeString(), Charsets.US_ASCII)
        val cases = vectors("declaration-code.json").getJSONArray("cases")
        val mine = (0 until cases.length()).map { cases.getJSONObject(it) }.filter { it.getString("scope_string") == testScope }
        assertTrue("cases in the test scope", mine.size >= 2)
        for (case in mine) {
            val code = DeviceCore.declarationCode(
                case.getJSONArray("accounts").toString().toByteArray(),
                case.getString("challenge").toByteArray(),
            )
            assertEquals(case.getString("label"), case.getString("declaration_code"), String(code, Charsets.US_ASCII))
        }
    }

    @Test
    fun `a list the core does not read is an exception with the code for input and nothing else`() {
        val challenge = vectors("declaration-code.json").getJSONArray("cases").getJSONObject(0).getString("challenge").toByteArray()
        val unsorted = """[{"platform":"threads","username":"alice"},{"platform":"test-example","username":"alice"}]"""
        val e = assertThrows(DeviceCoreException::class.java) { DeviceCore.declarationCode(unsorted.toByteArray(), challenge) }
        assertEquals(DeviceCoreException.INPUT, e.code)
        assertEquals("device-core: code 2", e.message)
    }

    @Test
    fun `the bytes passed in are still the caller's after the call`() {
        val case = vectors("declaration-code.json").getJSONArray("cases").getJSONObject(0)
        val accounts = "[]".toByteArray()
        val challenge = case.getString("challenge").toByteArray()
        DeviceCore.declarationCode(accounts, challenge)
        assertArrayEquals("[]".toByteArray(), accounts)
        assertArrayEquals(case.getString("challenge").toByteArray(), challenge)
    }
}
