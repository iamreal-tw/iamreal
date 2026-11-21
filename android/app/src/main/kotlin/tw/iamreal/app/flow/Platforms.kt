package tw.iamreal.app.flow

/**
 * What the screens write for a platform, fixed in the app and never taken
 * from the server (design/copy/card-proof.md, "每個平台不同的東西"). The
 * app knows Threads and no other platform: a platform of the server's
 * table that is not here is one the app does not know, and an account on
 * it is kept as it is.
 */
class Presentation(
    /** The platform ID. */
    val platform: String,
    /** The platform's name on the screen. */
    val name: String,
    /** What the screen writes before an account. */
    val prefix: String,
    /** The key of the format hint in design/copy/card-proof.json's `formats`. */
    val formatHint: String,
    /** The platform's own address, which "打開 Threads" opens. */
    val home: String,
    /** The address of an account's public page, which "預覽" opens. */
    val profileUrl: (String) -> String,
) {
    /** What was typed, tidied before its format is checked: one leading prefix dropped, `A` to `Z` in lower case (Threads does not distinguish case). */
    fun normalize(typed: String): String = typed.trim().removePrefix(prefix).map { if (it in 'A'..'Z') it.lowercaseChar() else it }.joinToString("")
}

object Platforms {
    val THREADS = Presentation(
        platform = "threads",
        name = "Threads",
        prefix = "@",
        formatHint = "threads",
        home = "https://www.threads.com/",
        profileUrl = { "https://www.threads.com/@$it" },
    )

    private val all = listOf(THREADS)

    /** The app's own definition of a platform; null for one it does not know. */
    fun of(platform: String): Presentation? = all.firstOrNull { it.platform == platform }

    /** The IDs of the platforms the app knows, as the core takes them: a JSON array. */
    val knownJson: ByteArray = all.joinToString(",", "[", "]") { "\"${it.platform}\"" }.toByteArray()

    /** An account as the screen writes it: `@alice`; as it is for a platform the app does not know. */
    fun handle(platform: String, username: String): String = (of(platform)?.prefix ?: "") + username
}
