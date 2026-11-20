# The JNI layer finds these by name (jni/iamreal_device_core_jni.c).
-keep class tw.iamreal.app.core.DeviceCoreException { <init>(int); }
-keepclasseswithmembernames class tw.iamreal.app.core.DeviceCore { native <methods>; }

# A release build writes no log: calls to android.util.Log are taken out,
# and the build fails if the class is still referred to (checkApkRelease).
-assumenosideeffects class android.util.Log { *; }
