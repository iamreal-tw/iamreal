#!/bin/sh
# Checks a built IamrealApp.app, and the sources it was built from, against
# what issue #168, ADR-0036 and ADR-0037 require of every build. The last build phase
# of the app target runs it, so a build that fails a check fails.
#
#   ./check-app.sh <path to IamrealApp.app>
#
# What it checks:
# - the app is the build its configuration makes (ADR-0037): Debug the
#   development build, tw.iamreal.app.dev, Release the store's build,
#   tw.iamreal.app; the name under its icon is the one design/copy/app.md
#   gives that build; until launch both talk to the test site: the addresses
#   of the test site in its executable and not the ones of the production
#   site;
# - iPhone only;
# - the two circuits and the two verification keys in the app are the files
#   of this repository, and the CRS has the SHA-256 of device-core/crs.sha256;
# - nothing in the app links AdSupport or AppTrackingTransparency, the app
#   embeds no framework and the project names no Swift package;
# - the sources (App/) do not read identifierForVendor and write nothing to
#   a log or to standard output, and neither do the sources of device-core/
#   (so a release build logs nothing of its own);
# - the sources reach C only through App/Bridge.h: it is the app's
#   bridging header, it is one #include of the header of device-core/, and
#   App/ holds no other C, Objective-C or module map. The tests have one of
#   their own, Tests/Bridge.h, which is one #include of the header of the
#   library of the tests;
# - only a Debug build for the simulator is linked with the library of the
#   tests: any other app has no idc_testing_session_open, the function
#   that opens a session trusting issuer keys other than MOICA's
#   (build-core.sh).
#
# What it does not see: what Barretenberg's own code prints, what Rust
# prints when the core panics (README.md, on logs), and anything a later
# change hides from these patterns. It guards against slips; it does not
# replace reading the change.
#
# IAMREAL_APP_SOURCES, IAMREAL_TEST_SOURCES, IAMREAL_PROJECT_FILE and
# IAMREAL_CONFIG_DIR replace the sources, the tests' sources, the project
# file and the directory of .xcconfig files it reads: check-app-test.sh
# uses them.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$here/..
app=${1:?usage: check-app.sh <path to IamrealApp.app>}
app=${app%/}
sources=${IAMREAL_APP_SOURCES:-$here/App}
tests=${IAMREAL_TEST_SOURCES:-$here/Tests}
project=${IAMREAL_PROJECT_FILE:-$here/IamrealApp.xcodeproj/project.pbxproj}
config=${IAMREAL_CONFIG_DIR:-$here/Config}
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

# The build the configuration makes (ADR-0037). Xcode hands the
# configuration to this script; run by hand, it goes by Debug, which is what
# the tests run in.
case ${CONFIGURATION-Debug} in
  Debug) want=tw.iamreal.app.dev build="開發用 build" ;;
  Release) want=tw.iamreal.app build="商店的 build" ;;
  *) want= build= ; problem "the configuration is $CONFIGURATION, neither Debug (the development build) nor Release (the store's build)" ;;
esac
identifier=$(plist CFBundleIdentifier)
if [ -n "$want" ] && [ "$identifier" != "$want" ]; then
  problem "the identifier is $identifier, not $want: a ${CONFIGURATION-Debug} build is the $build of ADR-0037"
fi
# The name under the icon: the first line in a code block under "### <build>"
# in the section "## 主畫面上的名稱" of design/copy/app.md. awk compares
# bytes: in a UTF-8 locale macOS's awk compares by collation, and takes
# the two headings for the same.
if [ -n "$build" ]; then
  written=$(LC_ALL=C awk -v build="### $build" '
    $0 == "## 主畫面上的名稱" { names = 1; next }
    names && $0 == build { here = 1; next }
    here && /^#/ { exit }
    here && $0 == "```" { getline; print; exit }
  ' "$repo/design/copy/app.md")
  name=$(plist CFBundleDisplayName)
  if [ -z "$written" ] || [ "$name" != "$written" ]; then
    problem "the name under the icon is $name, not \"$written\", the name design/copy/app.md gives the $build"
  fi
fi
# Until launch both builds talk to the test site (ADR-0037).
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

# The library of the tests, in a Debug build for the simulator only: its
# function, and the bytes device-core/ marks that library with. Xcode hands
# the configuration to this script; run by hand, on an app whose
# configuration it cannot know, it goes by the platform alone.
platforms=$(plutil -extract CFBundleSupportedPlatforms json -o - "$app/Info.plist" 2>/dev/null || true)
if [ "$platforms" != '["iPhoneSimulator"]' ] || [ "${CONFIGURATION-Debug}" != Debug ]; then
  for mark in idc_testing_session_open iamreal-device-core:testing-issuer-keys; do
    if executable_has "$mark"; then
      problem "an app for $platforms, configuration ${CONFIGURATION-unknown}, is linked with the library of the tests: its executable has $mark"
    fi
  done
fi

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

# The sources. Each pattern is an extended regular expression; B is what may
# stand before a name (the start of the line or a character that is not part
# of a name), so that fingerprint( is not print(.
B='(^|[^A-Za-z0-9_])'
forbidden() {
  why=$1
  where=$2
  shift 2
  [ -d "$where" ] || { problem "$where is not there"; return; }
  for pattern in "$@"; do
    found=$(grep -r -n -E -- "$pattern" "$where" || true)
    [ -z "$found" ] || problem "$why: $(printf '%s\n' "$found" | head -n 1)"
  done
}
forbidden "an identifier of the device or of advertising" "$sources" \
  'identifierForVendor|AdSupport|ASIdentifierManager|AppTrackingTransparency|ATTrackingManager'
forbidden "a log or standard output (a release build writes none)" "$sources" \
  "$B(print|debugPrint|dump|NSLog|os_log|os_signpost|Logger|printf|puts|fputs|fwrite|fatalError|preconditionFailure|assertionFailure)\\(" \
  "$B(OSLog|stdout|stderr)([^A-Za-z0-9_]|\$)" \
  'FileHandle\.standard'
forbidden "C reached another way than App/Bridge.h" "$sources" \
  "@_silgen_name|@_cdecl|@_extern|$B(dlsym|dlopen|bbapi)"
for crate in checks prover; do
  forbidden "the core writes to standard output" "$repo/device-core/$crate/src" \
    "$B(println|eprintln|print|eprint|dbg)!" \
    "$B(stdout|stderr)\\(\\)"
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
if [ ! -f "$tests/Bridge.h" ]; then
  problem "no Bridge.h in the tests' sources"
else
  code=$(grep -v -E '^[[:space:]]*(//.*)?$' "$tests/Bridge.h" || true)
  [ "$code" = '#include "iamreal_device_core_testing.h"' ] || problem "Tests/Bridge.h is more than the #include of iamreal_device_core_testing.h"
fi
# The app's target has App/Bridge.h, the tests' target Tests/Bridge.h, and nothing else names a header.
headers=$(grep -h -E 'SWIFT_OBJC_BRIDGING_HEADER|MODULEMAP_FILE|OTHER_SWIFT_FLAGS|OTHER_CFLAGS' "$project" "$config"/*.xcconfig | tr -d '\t' | sort | uniq -c | tr -s ' ' | sed 's/^ //')
want='2 SWIFT_OBJC_BRIDGING_HEADER = App/Bridge.h;
2 SWIFT_OBJC_BRIDGING_HEADER = Tests/Bridge.h;'
[ "$headers" = "$want" ] || problem "the bridging headers of the project and of Config/ are not App/Bridge.h for the app and Tests/Bridge.h for the tests: $headers"

exit $problems
