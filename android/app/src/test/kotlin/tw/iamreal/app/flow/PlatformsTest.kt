package tw.iamreal.app.flow

import org.junit.Assert.assertEquals
import org.junit.Test

class PlatformsTest {
    /** "分享到 Threads" opens Threads's web intent, written as the web's encodeURIComponent writes it (the value from Node). */
    @Test
    fun `the address of Threads's composer is encoded as the web encodes it`() {
        assertEquals(
            "https://www.threads.com/intent/post?text=%E6%88%91%E5%89%9B%E5%89%9B%E6%8F%9B%E4%BA%86%E7%AC%AC%201%2C284%20%E5%BC%B5%E5%B3%B6%E6%B0%91%E8%AD%89%E6%98%8E%E3%80%82%0Ahttps%3A%2F%2Fiamreal.tw%2Fp%2F7K2Q9FM4XD%20(!)",
            Platforms.THREADS.newPostUrl("我剛剛換了第 1,284 張島民證明。\nhttps://iamreal.tw/p/7K2Q9FM4XD (!)"),
        )
    }
}
