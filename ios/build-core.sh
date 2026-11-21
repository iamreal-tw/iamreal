#!/bin/sh
# Builds device-core/ for iOS: the static library the app links, and the
# files the app carries that are not in version control.
#
#   ./build-core.sh simulator    for the iOS simulator on an Apple silicon Mac
#   ./build-core.sh device       for an iPhone
#
# For the simulator it builds a second library too, the library of the
# tests: device-core/ with its cargo feature `test-issuers`, which adds
# idc_testing_session_open, a session that trusts the issuer keys a test
# gives it (Tests/ runs a card proof with a card made of test keys). It is
# built in a directory of its own, device-core/target/test-issuers/, so
# that no build links it by mistake; only the Debug configuration for the
# simulator links it (Config/Shared.xcconfig), and check-app.sh turns away
# any other app that holds it. There is no such library for an iPhone.
#
# It downloads Barretenberg's static library for that platform and the CRS,
# each checked against the SHA-256 in device-core/ before it is used
# (device-core/fetch-barretenberg.sh, device-core/fetch-crs.sh), then runs
# cargo. The library is left where cargo writes it:
# device-core/target/<target>/release/libiamreal_device_core.a, which is
# where the Xcode project looks for it (Config/Shared.xcconfig).
#
# Run it from a shell, not from an Xcode build phase: it downloads, and
# Xcode's environment (SDKROOT and others) is for iOS, not for the build
# scripts cargo runs on the Mac.
set -eu

case ${1-} in
  simulator) platform=arm64-ios-sim target=aarch64-apple-ios-sim ;;
  device) platform=arm64-ios target=aarch64-apple-ios ;;
  *) echo "usage: build-core.sh simulator|device" >&2; exit 1 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
core=$here/../device-core

# The lowest iOS the library runs on: the same number as
# IPHONEOS_DEPLOYMENT_TARGET in Config/Shared.xcconfig (README.md).
IPHONEOS_DEPLOYMENT_TARGET=$(sed -n 's/^IPHONEOS_DEPLOYMENT_TARGET = //p' "$here/Config/Shared.xcconfig")
[ -n "$IPHONEOS_DEPLOYMENT_TARGET" ] || { echo "build-core: no IPHONEOS_DEPLOYMENT_TARGET in Config/Shared.xcconfig" >&2; exit 1; }
export IPHONEOS_DEPLOYMENT_TARGET

"$core/fetch-crs.sh" >/dev/null
BB_LIB_DIR=$("$core/fetch-barretenberg.sh" "$platform")
export BB_LIB_DIR

cd "$core"
cargo build --locked --release --package iamreal-device-core --lib --target "$target"
if [ "$1" = simulator ]; then
  cargo build --locked --release --package iamreal-device-core --lib --target "$target" \
    --features test-issuers --target-dir "$core/target/test-issuers"
fi
