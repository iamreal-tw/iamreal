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
 * app's roster. The screens of the card proof replace it.
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
                DeviceCore.selfCheck()
                "idc_self_check 0\nidc_scope_string ${String(DeviceCore.scopeString(), Charsets.US_ASCII)}"
            } catch (e: DeviceCoreException) {
                "idc_self_check ${e.code}"
            }
            runOnUiThread { text.text = lines }
        }
    }
}
