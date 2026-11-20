#!/bin/sh
# Checks a built IamrealApp.app, and the sources it was built from, against
# what issue #168 and ADR-0036 require of every build. The last build phase
# of the app target runs it, so a build that fails a check fails.
#
#   ./check-app.sh <path to IamrealApp.app>
#
# What it checks:
# - the app is the test app: the identifier tw.iamreal.app.test, with the
#   addresses of the test site in its executable and not the ones of the
#   production site;
# - iPhone only;
# - the two circuits and the two verification keys in the app are the files
#   of this repository, and the CRS has the SHA-256 of device-core/crs.sha256;
# - nothing in the app links AdSupport or AppTrackingTransparency, the app
#   embeds no framework and the project names no Swift package;
# - the sources (App/) do not read identifierForVendor and write nothing to
#   a log or to standard output, and neither do the sources of device-core/
#   (so a release build logs nothing of its own);
# - the sources reach C only through App/Bridge.h: it is the project's
#   bridging header, it is one #include of the header of device-core/, and
#   App/ holds no other C, Objective-C or module map.
#
# What it does not see: what Barretenberg's own code prints, what Rust
# prints when the core panics (README.md, on logs), and anything a later
# change hides from these patterns. It guards against slips; it does not
# replace reading the change.
#
# IAMREAL_APP_SOURCES and IAMREAL_PROJECT_FILE replace the sources and the
# project file it reads: check-app-test.sh uses them.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$here/..
app=${1:?usage: check-app.sh <path to IamrealApp.app>}
app=${app%/}
sources=${IAMREAL_APP_SOURCES:-$here/App}
project=${IAMREAL_PROJECT_FILE:-$here/IamrealApp.xcodeproj/project.pbxproj}
problems=0

problem() {
  echo "check-app: $*" >&2
  problems=1
}

plist() {
  plutil -extract "$1" raw -o - "$app/Info.plist" 2>/dev/null || true
}

# Every Mach-O file of the app itself: the executable and, in a debug build,
# the libraries Xcode splits it into. Not PlugIns/, where the tests go.
binaries=$(find "$app" -path "$app/PlugIns" -prune -o -type f -print | while read -r f; do
  if xcrun otool -h "$f" 2>/dev/null | grep -q "Mach header"; then echo "$f"; fi
done)
[ -n "$binaries" ] || problem "no executable in $app"

# Whether some executable of the app has these bytes in it.
executable_has() {
  echo "$binaries" | while read -r f; do
    if LC_ALL=C grep -q -a -F -- "$1" "$f"; then echo yes; fi
  done | grep -q yes
}

# The test app, the test site.
identifier=$(plist CFBundleIdentifier)
if [ "$identifier" != tw.iamreal.app.test ]; then
  problem "the identifier is $identifier, not tw.iamreal.app.test: the only app built so far is the test app"
fi
# Xcode hands the build settings to this script: the environment of Config/.
if [ "${IAMREAL_ENVIRONMENT-IAMREAL_ENV_TEST}" != IAMREAL_ENV_TEST ]; then
  problem "the environment is $IAMREAL_ENVIRONMENT, not IAMREAL_ENV_TEST"
fi
for address in https://test.iamreal.tw https://test-data.iamreal.tw; do
  executable_has "$address" || problem "the executable does not have the address $address"
done
for address in https://iamreal.tw https://data.iamreal.tw; do
  if executable_has "$address"; then
    problem "the executable has the address of the production site, $address"
  fi
done

# iPhone only.
family=$(plutil -extract UIDeviceFamily json -o - "$app/Info.plist" 2>/dev/null || true)
[ "$family" = "[1]" ] || problem "UIDeviceFamily is $family, not [1] (iPhone only)"

# The files the app carries.
while read -r name source; do
  if ! cmp -s "$app/$name" "$repo/$source"; then
    problem "$name in the app is not $source"
  fi
done <<LIST
card_proof_rs2048.json web/circuits/card_proof_rs2048.json
card_proof_rs4096.json web/circuits/card_proof_rs4096.json
card_proof_rs2048.vk verifier/vk/card_proof_rs2048.vk
card_proof_rs4096.vk verifier/vk/card_proof_rs4096.vk
LIST
while read -r want name; do
  got=$( (shasum -a 256 "$app/$name" 2>/dev/null || true) | cut -d ' ' -f 1)
  [ "$got" = "$want" ] || problem "$name in the app does not have the SHA-256 of device-core/crs.sha256"
done < "$repo/device-core/crs.sha256"

# No advertising identifier, no third-party code.
links=$(echo "$binaries" | while read -r f; do
  xcrun otool -L "$f" | grep -E "AdSupport|AppTrackingTransparency" | sed "s|^|${f#"$app"/} links |"
done | tr -s '\t\n' '  ')
[ -z "$links" ] || problem "$links"
[ ! -e "$app/Frameworks" ] || problem "the app embeds something in Frameworks/"
if grep -q -E "XCRemoteSwiftPackageReference|XCLocalSwiftPackageReference|XCSwiftPackageProductDependency" "$project"; then
  problem "the project names a Swift package"
fi

# The sources. Each pattern is a fixed string.
forbidden() {
  why=$1
  where=$2
  shift 2
  for pattern in "$@"; do
    found=$(grep -r -n -F -- "$pattern" "$where" || true)
    [ -z "$found" ] || problem "$why: \"$pattern\" in $(printf '%s\n' "$found" | head -n 1)"
  done
}
forbidden "an identifier of the device or of advertising" "$sources" \
  identifierForVendor AdSupport ASIdentifierManager AppTrackingTransparency ATTrackingManager
forbidden "a log or standard output (a release build writes none)" "$sources" \
  "print(" "debugPrint(" "dump(" "NSLog(" "os_log(" "Logger(" OSLog os_signpost \
  "printf(" "puts(" "fwrite(" "FileHandle.standard" stdout stderr \
  "fatalError(" "preconditionFailure(" "assertionFailure("
forbidden "C reached another way than App/Bridge.h" "$sources" \
  "@_silgen_name" "@_cdecl" "@_extern" dlsym dlopen bbapi
for crate in checks prover; do
  forbidden "the core writes to standard output" "$repo/device-core/$crate/src" \
    "println!" "eprintln!" "print!" "eprint!" "dbg!"
done

# C only through App/Bridge.h, which is the one #include.
other=$(find "$sources" -type f \( -name '*.h' -o -name '*.c' -o -name '*.m' -o -name '*.mm' -o -name '*.cpp' -o -name '*.modulemap' \) ! -path "$sources/Bridge.h")
[ -z "$other" ] || problem "C, Objective-C or a module map in the sources other than Bridge.h: $(printf '%s\n' "$other" | head -n 1)"
if [ ! -f "$sources/Bridge.h" ]; then
  problem "no Bridge.h in the sources"
else
  code=$(grep -v -E '^[[:space:]]*(//.*)?$' "$sources/Bridge.h" || true)
  [ "$code" = '#include "iamreal_device_core.h"' ] || problem "App/Bridge.h is more than the #include of iamreal_device_core.h"
fi
headers=$(grep -E 'SWIFT_OBJC_BRIDGING_HEADER|MODULEMAP_FILE|OTHER_SWIFT_FLAGS|OTHER_CFLAGS' "$project" | tr -d '\t' | sort -u)
[ "$headers" = 'SWIFT_OBJC_BRIDGING_HEADER = App/Bridge.h;' ] || problem "the project's bridging header is not App/Bridge.h alone: $headers"

exit $problems
