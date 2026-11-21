package tw.iamreal.app.ui

import org.json.JSONObject

/**
 * The sentences of the card proof: design/copy/card-proof.json as it is,
 * which the build puts into the installer (`raw/card_proof_copy.json`,
 * app/build.gradle.kts). Every sentence on a screen is read from here; none
 * is written in the app's code.
 */
class Copy(text: String) {
    private val groups = JSONObject(text)

    /** The sentence `group.key`, with each `{name}` of it replaced by its value. */
    fun say(key: String, vararg values: Pair<String, Any>): String {
        val (group, name) = key.split(".")
        var sentence = groups.getJSONObject(group).getString(name)
        for ((k, v) in values) sentence = sentence.replace("{$k}", v.toString())
        return sentence
    }

    /** Whether the copy has the sentence. */
    fun has(key: String): Boolean {
        val (group, name) = key.split(".")
        return groups.optJSONObject(group)?.has(name) == true
    }
}
