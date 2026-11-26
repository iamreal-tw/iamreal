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
    fun `the minimum app version is read as the cases of the Android app say`() {
        val cases = vectors("min-app.json").getJSONArray("cases")
        val mine = (0 until cases.length()).map { cases.getJSONObject(it) }.filter { it.getString("client") == "android" }
        assertTrue("cases of the Android app", mine.size >= 20)
        val verdicts = mutableSetOf<String>()
        for (case in mine) {
            val answer = JSONObject(String(DeviceCore.minApp(case.getJSONObject("config").toString().toByteArray(), case.getInt("app_build"), case.getLong("now"))))
            assertEquals(case.getString("name"), case.getString("result"), answer.getString("verdict"))
            if (case.getString("result") == "ok_until") assertEquals(case.getString("name"), case.getString("from"), answer.getString("from"))
            verdicts += answer.getString("verdict")
        }
        assertEquals(setOf("ok", "ok_until", "stop", "unreadable"), verdicts)
        // A build below 0 is a mistake of the app's code, not a build that is too old.
        val e = assertThrows(DeviceCoreException::class.java) { DeviceCore.minApp("{}".toByteArray(), -1, 1_803_830_400) }
        assertEquals(DeviceCoreException.ARGUMENT, e.code)
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
