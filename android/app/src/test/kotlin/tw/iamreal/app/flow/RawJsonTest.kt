package tw.iamreal.app.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RawJsonTest {
    private fun member(json: String, key: String): String? = RawJson.member(json.toByteArray(), key)?.let { String(it) }

    @Test
    fun `a member is cut out as it was written`() {
        val config = """ {"crl_max_age_days":3, "platforms" : [ {"platform":"threads","display_name":"Th\"r}eads","n":1.0e0} , [] ] ,"min_app":{"android":{"build":1}}} """
        assertEquals("""[ {"platform":"threads","display_name":"Th\"r}eads","n":1.0e0} , [] ]""", member(config, "platforms"))
        assertEquals("3", member(config, "crl_max_age_days"))
        assertEquals("""{"android":{"build":1}}""", member(config, "min_app"))
        assertEquals("\"a\"", member("""{"x":"a"}""", "x"))
        assertEquals("null", member("""{"x":null}""", "x"))
    }

    @Test
    fun `no member, a member twice, or not one object, is nothing`() {
        assertNull(member("""{"a":1}""", "platforms"))
        assertNull(member("""{}""", "platforms"))
        assertNull(member("""{"platforms":[],"platforms":[]}""", "platforms"))
        assertNull(member("""[{"platforms":[]}]""", "platforms"))
        assertNull(member("""{"platforms":[]} x""", "platforms"))
        assertNull(member("""{"platforms":[}""", "platforms"))
        assertNull(member("""{"platforms":""", "platforms"))
        assertNull(member("""{"platforms":[],}""", "platforms"))
        assertNull(member("", "platforms"))
        // A member of an inner object is not the object's.
        assertNull(member("""{"a":{"platforms":[]}}""", "platforms"))
    }
}
