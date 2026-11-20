package tw.iamreal.app

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import tw.iamreal.app.core.DeviceCore
import tw.iamreal.app.core.DeviceCoreException
import kotlin.concurrent.thread

/**
 * The shell: one screen that shows the core was called. It is not a screen
 * of the card proof and holds no sentence for a cardholder: two lines, the
 * code idc_self_check answered and the scope string the core has for this
 * app's roster, each after the code of its call. The screens of the card proof replace it.
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this).apply {
            setTextIsSelectable(true)
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            fitsSystemWindows = true
        }
        setContentView(text)
        thread {
            val lines = try {
                listOf(
                    line("idc_self_check") { DeviceCore.selfCheck(); "" },
                    line("idc_scope_string") { String(DeviceCore.scopeString(), Charsets.US_ASCII) },
                ).joinToString("\n")
            } catch (e: LinkageError) {
                // The library is not in the installer, or it is not the one the JNI layer was built for.
                "System.loadLibrary ${e.javaClass.simpleName}"
            }
            runOnUiThread { text.text = lines }
        }
    }

    /** `name 0`, then what the call gave; or `name` and the code the core answered with. */
    private fun line(name: String, call: () -> String): String = try {
        "$name 0 ${call()}".trimEnd()
    } catch (e: DeviceCoreException) {
        "$name ${e.code}"
    }
}
