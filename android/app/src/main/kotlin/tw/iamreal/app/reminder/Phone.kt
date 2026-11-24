package tw.iamreal.app.reminder

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import tw.iamreal.app.MainActivity
import tw.iamreal.app.R
import tw.iamreal.app.ui.Copy
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * The reminder on the phone: its four things in the app's own preferences, the system's alarm, the
 * notification. All of it on the phone; no server is asked for anything (issue #93).
 */
internal object Phone {
    /** The reminder of this phone. */
    fun reminders(context: Context): Reminders = Reminders(PreferencesStorage(context), SystemAlarm(context))

    /** Today, and now, on the phone's clock in its own time zone: a reminder comes at 9 in the evening where the phone is. */
    fun today(): LocalDate = LocalDate.now(ZoneId.systemDefault())

    fun now(): LocalDateTime = LocalDateTime.now(ZoneId.systemDefault())

    /** The words only the app has (design/copy/app.json), as the build put them in the installer. */
    fun words(context: Context): Copy = Copy(context.resources.openRawResource(R.raw.app_copy).use { String(it.readBytes(), Charsets.UTF_8) })

    /** Whether the system lets the app post a notification: the permission of Android 13 on, and notifications not turned off for the app. */
    fun notificationsAllowed(context: Context): Boolean = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    /** The extra of the intent that opens the app from the notification: step 1 says it is the reminder. */
    const val FROM_REMINDER = "tw.iamreal.app.FROM_REMINDER"

    /** Posts the notification (design/copy/app.md, "通知"): once, with "一週後再提醒我". */
    fun notify(context: Context) {
        val words = words(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, words.say("notification.channel"), NotificationManager.IMPORTANCE_DEFAULT))
        val open = Intent(context, MainActivity::class.java)
            .putExtra(FROM_REMINDER, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val snooze = Intent(context, ReminderReceiver::class.java).setAction(ReminderReceiver.SNOOZE)
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.notification_mark)
            .setContentTitle(words.say("notification.title"))
            .setContentText(words.say("notification.body"))
            .setStyle(Notification.BigTextStyle().bigText(words.say("notification.body")))
            .setContentIntent(PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .addAction(Notification.Action.Builder(null, words.say("notification.snooze"), PendingIntent.getBroadcast(context, 0, snooze, PendingIntent.FLAG_IMMUTABLE)).build())
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION, notification)
    }

    /** Takes the notification away, if it is there. */
    fun dismiss(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
    }

    private const val CHANNEL = "reminder"
    private const val NOTIFICATION = 1
}

/**
 * The four things in the app's own preferences (`shared_prefs/reminder.xml`). Turned off, the file
 * holds nothing. Not in a backup (AndroidManifest.xml, allowBackup).
 */
private class PreferencesStorage(context: Context) : Storage {
    private val preferences = context.getSharedPreferences("reminder", Context.MODE_PRIVATE)

    override fun read(): Map<String, String> = preferences.all.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }.toMap()

    override fun write(values: Map<String, String>) {
        // At once, not later: the alarm that follows reads it.
        preferences.edit().clear().apply { for ((k, v) in values) putString(k, v) }.commit()
    }
}

/**
 * The system's alarm. Not an exact alarm, which needs a permission of its own from Android 12 on: the
 * system may hold it back by a few minutes, at most [WINDOW_MS], longer when the phone has lain unused for
 * a long time (Doze). A reminder does not need the minute.
 */
private class SystemAlarm(private val context: Context) : Alarm {
    private val manager = context.getSystemService(AlarmManager::class.java)

    private fun intent(): PendingIntent =
        PendingIntent.getBroadcast(context, 0, Intent(context, ReminderReceiver::class.java).setAction(ReminderReceiver.FIRE), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    override fun set(at: LocalDateTime) {
        // A notification still up is of the reminder this one replaces: its 一週後再提醒我 would undo the new day.
        Phone.dismiss(context)
        manager.setWindow(AlarmManager.RTC_WAKEUP, at.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli(), WINDOW_MS, intent())
    }

    override fun cancel() {
        manager.cancel(intent())
        Phone.dismiss(context)
    }

    private companion object {
        /** The least the system allows from Android 12 on. */
        const val WINDOW_MS = 10 * 60 * 1000L
    }
}

/**
 * What the system calls the app for, none of it callable by another app (exported false): the alarm
 * (the notification), "一週後再提醒我" on the notification, and the moments the system forgets the alarm
 * or its time changes meaning (the phone restarted, the app was updated, the time zone changed).
 */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val reminders = Phone.reminders(context)
        when (intent.action) {
            // Only for a reminder that is on and due: not an alarm left over from before it was changed.
            FIRE -> if (reminders.passed(Phone.now())) Phone.notify(context)
            SNOOZE -> {
                reminders.snooze(Phone.today())
                Phone.dismiss(context)
            }
            // The alarm was forgotten with the phone switched off: one that came meanwhile, within a day, is notified now.
            Intent.ACTION_BOOT_COMPLETED -> if (reminders.missed(Phone.now())) Phone.notify(context) else reminders.rearm(Phone.now())
            Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIMEZONE_CHANGED -> reminders.rearm(Phone.now())
        }
    }

    companion object {
        const val FIRE = "tw.iamreal.app.reminder.FIRE"
        const val SNOOZE = "tw.iamreal.app.reminder.SNOOZE"
    }
}
