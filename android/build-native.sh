#!/bin/sh
# Builds libiamreal_device_core_jni: device-core/'s static library and the
# JNI layer (jni/), linked into one shared library.
#
#   ./build-native.sh arm64-v8a <api> <out-dir>   for phones
#   ./build-native.sh x86_64 <api> <out-dir>      for the emulator on x86-64
#   ./build-native.sh host <out-dir>              for this machine: what the
#                                                 unit tests load on the JVM
#
# <api> is the Android API level the library is linked for (minSdk).
#
# For Android the link is done by Zig 0.15.1 (fetch-zig.sh), the Zig Aztec
# builds Barretenberg with, and libc++ is linked in statically: Aztec's
# library uses LLVM's libc++ (std::__1), which does not link against the
# NDK's (std::__ndk1) (issue #88). The NDK gives the C headers and
# libraries of Android (its sysroot), named by ANDROID_NDK_ROOT, and the C
# compiler for the one crate with C in it: blake3 (through Noir's ACVM)
# compiles its SIMD code, C and assembly, with cc-rs. That code uses no C++.
#
# Reads: ANDROID_NDK_ROOT (Android), JAVA_HOME and CC (host).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
core=$here/../device-core
[ $# -ge 1 ] || { echo "build-native: see the top of this file" >&2; exit 1; }
abi=$1

BB_LIB_DIR=
build_core() { # <Barretenberg's platform, or nothing for this machine> <cargo's target, or nothing>
  BB_LIB_DIR=$("$core/fetch-barretenberg.sh" $1)
  export BB_LIB_DIR
  (cd "$core" && cargo build --locked --release --package iamreal-device-core --lib ${2:+--target "$2"})
}

if [ "$abi" = host ]; then
  [ $# -eq 2 ] || { echo "build-native: host <out-dir>" >&2; exit 1; }
  out=$2
  : "${JAVA_HOME:?build-native: JAVA_HOME is not set}"
  build_core "" ""
  mkdir -p "$out"
  case "$(uname -s)" in
    Darwin)
      "${CC:-cc}" -shared -fPIC -O2 -Wall -Wextra -Werror -I "$core/include" -I "$JAVA_HOME/include" -I "$JAVA_HOME/include/darwin" \
        -o "$out/libiamreal_device_core_jni.dylib" "$here/jni/iamreal_device_core_jni.c" \
        "$core/target/release/libiamreal_device_core.a" -lc++ -liconv -lm
      ;;
    Linux)
      # The libraries device-core/prover/tests/c_link.rs names: LLVM's libc++, not GCC's libstdc++.
      "${CC:-cc}" -shared -fPIC -O2 -Wall -Wextra -Werror -I "$core/include" -I "$JAVA_HOME/include" -I "$JAVA_HOME/include/linux" \
        -o "$out/libiamreal_device_core_jni.so" "$here/jni/iamreal_device_core_jni.c" \
        "$core/target/release/libiamreal_device_core.a" -lc++ -lc++abi -lgcc_s -lutil -lrt -lpthread -lm -ldl -lc
      ;;
    *) echo "build-native: no host build for this machine" >&2; exit 1 ;;
  esac
  exit 0
fi

[ $# -eq 3 ] || { echo "build-native: <abi> <api> <out-dir>" >&2; exit 1; }
api=$2
out=$3
case $api in
  *[!0-9]* | "") echo "build-native: the API level is not a number" >&2; exit 1 ;;
esac
case $abi in
  arm64-v8a) triple=aarch64-linux-android; platform=arm64-android ;;
  x86_64) triple=x86_64-linux-android; platform=x86_64-android ;;
  *) echo "build-native: not arm64-v8a, x86_64 or host" >&2; exit 1 ;;
esac
: "${ANDROID_NDK_ROOT:?build-native: ANDROID_NDK_ROOT is not set}"
case "$(uname -s)" in
  Darwin) ndk_host=darwin-x86_64 ;;
  Linux) ndk_host=linux-x86_64 ;;
  *) echo "build-native: no NDK for this machine" >&2; exit 1 ;;
esac
sysroot=$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/$ndk_host/sysroot
crt=$sysroot/usr/lib/$triple/$api
[ -d "$crt" ] || { echo "build-native: the NDK has no API level $api for $triple" >&2; exit 1; }

# cc-rs reads CC_<target> and AR_<target>, the target's dashes as underscores.
ndk_bin=$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/$ndk_host/bin
cc_target=$(printf %s "$triple" | tr - _)
export "CC_$cc_target=$ndk_bin/$triple$api-clang" "AR_$cc_target=$ndk_bin/llvm-ar"

zig=$("$here/fetch-zig.sh")
build_core "$platform" "$triple"

mkdir -p "$out"
# Where Zig finds Android's C library: the NDK's sysroot.
libc=$out/zig-libc.txt
printf 'include_dir=%s\nsys_include_dir=%s\ncrt_dir=%s\nmsvc_lib_dir=\nkernel32_lib_dir=\ngcc_dir=\n' \
  "$sysroot/usr/include" "$sysroot/usr/include/$triple" "$crt" > "$libc"

# No -llog: nothing in the library can write to Android's log.
# -z defs: a function nobody defines stops the link here, not the app at load.
# max-page-size: phones with 16 KB pages.
ZIG_LIBC=$libc "$zig" c++ -target "$triple.$api" -shared -fPIC -O2 -Wall -Wextra -Werror \
  -I "$core/include" -o "$out/libiamreal_device_core_jni.so" \
  -x c "$here/jni/iamreal_device_core_jni.c" -x none "$core/target/$triple/release/libiamreal_device_core.a" \
  -L"$crt" -lm -ldl \
  -Wl,--gc-sections -Wl,--version-script="$here/jni/exports.map" -Wl,-z,defs -Wl,-z,max-page-size=16384 -s
rm -f "$libc"
