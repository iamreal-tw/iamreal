# The JNI layer finds these by name (jni/iamreal_device_core_jni.c).
-keep class tw.iamreal.app.core.DeviceCoreException { <init>(int); }
-keepclasseswithmembernames class tw.iamreal.app.core.DeviceCore { native <methods>; }

# A release build writes no log: calls to android.util.Log are taken out,
# and the build fails if the class is still referred to (checkApkRelease).
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
    public static int w(...);
    public static int e(...);
    public static int wtf(...);
    public static int println(...);
    public static boolean isLoggable(...);
    public static java.lang.String getStackTraceString(...);
}

# androidx.window (it comes with Compose) names classes that only a phone
# with a folding screen's own extensions has; they are not in the installer.
-dontwarn androidx.window.extensions.**
-dontwarn androidx.window.sidecar.**

# The libraries of the screens write to System.out and to java.util.logging
# in a few places (warnings of Compose's about focus and key events, a
# listener that threw in androidx.concurrent). On a phone both end in the
# system's log, so the calls are taken out like those to android.util.Log
# above, and the build fails if a call that writes is still there
# (checkApkRelease). What stays is System.out read and not used, and a
# Logger made and not used: R8 does not take out a read of a field or a
# call whose result is kept in a field.
-assumenosideeffects class java.io.PrintStream {
    public void println(...);
    public void print(...);
}
-assumenosideeffects class java.util.logging.Logger {
    public void log(...);
}
