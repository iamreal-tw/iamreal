package tw.iamreal.app

import android.Manifest
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import kotlinx.coroutines.delay
import org.json.JSONObject
import tw.iamreal.app.flow.CardProof
import tw.iamreal.app.reminder.Phone
import tw.iamreal.app.ui.CardProofScreens
import tw.iamreal.app.ui.Copy
import tw.iamreal.app.ui.Model
import tw.iamreal.app.ui.Outside
import tw.iamreal.app.ui.Pickers
import tw.iamreal.app.ui.ReminderModel
import tw.iamreal.app.ui.Screen
import tw.iamreal.app.ui.ScheduleScreen
import tw.iamreal.app.ui.SettingsScreen
import tw.iamreal.app.ui.Splash
import tw.iamreal.app.ui.Step
import java.time.LocalDate
import java.time.LocalTime

/**
 * The app's one screen: the card proof, step by step (ui/), after the splash
 * when the app starts (ui/Splash.kt). The state of a
 * card proof under way is in the process's memory only ([Model]): nothing
 * of it goes into the saved state of the activity or onto storage, so an
 * app the system ended starts at step 1 (issue #133).
 *
 * The island proof, the proof log and the help pages are not in the app: they
 * open in the browser.
 *
 * Besides it, the settings and the reminder's interval and time
 * ([ReminderModel]). What the app stores is the highest CRL numbers it used
 * ([StoredCrlNumbers]) and the reminder's four things (reminder/), which are
 * the phone's, not a card's.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Nothing is restored: there is nothing saved.
        super.onCreate(null)
        // The screens draw under the system's bars, white as the pages, with dark icons whatever the system's own look.
        enableEdgeToEdge(SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT), SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT))
        val model = model(applicationContext)
        val reminder = reminder(applicationContext)
        // A card proof completed: the reminder that is on comes again from today.
        model.onDone = { reminder.cardProofDone() }
        // The system forgets alarms when the app is stopped by force: set again whenever the app opens.
        Phone.reminders(applicationContext).rearm(Phone.now())
        val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val told = asked
            asked = null
            told?.invoke(granted && Phone.notificationsAllowed(this))
        }
        // Android 13 on asks the cardholder; before it the app may notify unless notifications were turned off for it.
        reminder.askPermission = { told ->
            if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                told(Phone.notificationsAllowed(this))
            } else {
                asked = told
                permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        val pickers = Pickers(
            day = { initial, range, picked ->
                DatePickerDialog(this, { _, y, m, d -> picked(LocalDate.of(y, m + 1, d)) }, initial.year, initial.monthValue - 1, initial.dayOfMonth).apply {
                    val zone = java.time.ZoneId.systemDefault()
                    datePicker.minDate = range.start.atStartOfDay(zone).toInstant().toEpochMilli()
                    datePicker.maxDate = range.endInclusive.atStartOfDay(zone).toInstant().toEpochMilli()
                }.show()
            },
            time = { initial, picked -> TimePickerDialog(this, { _, h, m -> picked(LocalTime.of(h, m)) }, initial.hour, initial.minute, false).show() },
        )
        val version = packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        // Not when the system makes the activity again (its process was ended in the background): the intent is the one it was first opened with.
        if (savedInstanceState == null) handle(intent)
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
            share = { text ->
                // The system's share sheet with the text the screen gives; which app it goes to is the cardholder's to pick.
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                try {
                    startActivity(Intent.createChooser(send, null))
                } catch (e: ActivityNotFoundException) {
                    // Nothing on the phone to share with: nothing to do here.
                }
            },
        )
        val words = JSONObject(resources.openRawResource(R.raw.app_copy).use { String(it.readBytes(), Charsets.UTF_8) }).getJSONObject("splash")
        val serviceName = model.copy.say("common.service_name")
        setContentView(
            ComposeView(this).apply {
                setContent {
                    // The splash once, when the process starts: not when the app comes back to the screen.
                    var splash by remember { mutableStateOf(!splashShown) }
                    if (splash) {
                        Splash(words.getString("name"), words.getString("site"))
                        LaunchedEffect(Unit) {
                            delay(SPLASH_MS)
                            splashShown = true
                            splash = false
                        }
                    } else {
                        when (reminder.screen) {
                            Screen.CARD_PROOF -> CardProofScreens(model, reminder, outside)
                            Screen.SETTINGS -> SettingsScreen(reminder, outside, version, model.site)
                            Screen.SCHEDULE -> ScheduleScreen(reminder, pickers, serviceName)
                        }
                    }
                }
            },
        )
        // The system's back is the step's "上一步" where it has one; the first and the last screen leave the app.
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (reminder.back()) return
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
        // "一週後再提醒我" on the notification may have changed the reminder meanwhile.
        reminder(applicationContext).refresh()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /**
     * Opened from the reminder's notification: step 1 says so. A card proof under way is left as it is; from
     * step 6, back to step 1. Another app could open the app the same way: all it gets is that sentence.
     */
    private fun handle(intent: Intent?) {
        if (intent?.getBooleanExtra(Phone.FROM_REMINDER, false) != true) return
        // Opened again from the list of recent apps: the system hands back the intent the task began with.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        intent.removeExtra(Phone.FROM_REMINDER)
        val model = model(applicationContext)
        reminder(applicationContext).openedFromNotification()
        if (model.step == Step.DONE) model.cancel()
    }

    /** Told whether the app may notify, once the system has asked: the one waiting for it. */
    private var asked: ((Boolean) -> Unit)? = null

    override fun onSaveInstanceState(outState: Bundle) {
        // Nothing of a card proof goes into the system's saved state.
        super.onSaveInstanceState(Bundle())
    }

    companion object {
        private var model: Model? = null
        private var reminder: ReminderModel? = null

        /** The splash was shown in this process. */
        private var splashShown = false

        /** How long the splash stays: long enough to read the name and the site. */
        private const val SPLASH_MS = 1_200L

        /** The one card proof of this process. */
        private fun model(context: Context): Model = model ?: Model(
            Target.wiring(context),
            bundled = { name -> context.assets.open(name).use { it.readBytes() } },
            crlNumbers = StoredCrlNumbers(context),
            copy = Copy(context.resources.openRawResource(R.raw.card_proof_copy).use { String(it.readBytes(), Charsets.UTF_8) }),
        ).also { model = it }

        /** The reminder as the screens show it, for this process. */
        private fun reminder(context: Context): ReminderModel = reminder ?: ReminderModel(
            Phone.reminders(context),
            Phone.words(context),
            today = Phone::today,
            now = Phone::now,
        ).also { reminder = it }
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
