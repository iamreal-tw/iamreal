package tw.iamreal.app

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.compose.ui.platform.ComposeView
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.ui.CardProofScreens
import tw.iamreal.app.ui.Copy
import tw.iamreal.app.ui.Model
import tw.iamreal.app.ui.Outside
import tw.iamreal.app.ui.Step

/**
 * The app's one screen: the card proof, step by step (ui/). The state of a
 * card proof under way is in the process's memory only ([Model]): nothing
 * of it goes into the saved state of the activity or onto storage, so an
 * app the system ended starts at step 1 (issue #133).
 *
 * The island proof, the roster and the help pages are not in the app: they
 * open in the browser.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Nothing is restored: there is nothing saved.
        super.onCreate(null)
        val model = model(applicationContext)
        val outside = Outside(
            open = { address ->
                try {
                    // In the browser's own task, not on top of the card proof: coming back to the app finds the step as it was.
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: ActivityNotFoundException) {
                    // No app on the phone opens an address: nothing to do here.
                }
            },
            copy = { text -> (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("", text)) },
        )
        setContentView(ComposeView(this).apply { setContent { CardProofScreens(model, outside) } })
        // The system's back is the step's "上一步" where it has one; the first and the last screen leave the app.
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (model.panel != null) return model.cancelTap()
                    when (model.step) {
                        Step.BEFORE, Step.DONE -> finish()
                        Step.READ -> model.backToBefore()
                        Step.PIN -> model.backToRead()
                        Step.CONFIRM -> model.backToAccounts()
                        // No way back but "取消", which drops the PIN.
                        Step.ACCOUNTS, Step.PROGRESS -> {}
                    }
                }
            },
        )
    }

    override fun onResume() {
        super.onResume()
        // The timer of the PIN's 5 minutes may not have run while the app was away.
        model(applicationContext).checkIdle()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        // Nothing of a card proof goes into the system's saved state.
        super.onSaveInstanceState(Bundle())
    }

    companion object {
        private var model: Model? = null

        /** The one card proof of this process. */
        private fun model(context: Context): Model = model ?: Model(
            Target.wiring(context),
            bundled = { name -> context.assets.open(name).use { it.readBytes() } },
            crlNumbers = StoredCrlNumbers(context),
            copy = Copy(context.resources.openRawResource(R.raw.card_proof_copy).use { String(it.readBytes(), Charsets.UTF_8) }),
        ).also { model = it }
    }
}

/**
 * The one thing the app stores: per issuer key, the highest CRL number the
 * phone has used (spec/device-checks.md), in the app's own preferences. A
 * CRL number is public; no certificate, signature, PIN, scoped ID or
 * account is ever stored.
 */
private class StoredCrlNumbers(context: Context) : CardProof.CrlNumbers {
    private val preferences = context.getSharedPreferences("highest_crl_number", Context.MODE_PRIVATE)

    override fun get(issuer: String): String? = preferences.getString(issuer, null)?.takeIf { n -> n.isNotEmpty() && n.all { it in '0'..'9' } }

    override fun set(issuer: String, number: String) {
        preferences.edit().putString(issuer, number).apply()
    }
}
