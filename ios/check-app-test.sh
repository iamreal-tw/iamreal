#!/bin/sh
# The test of check-app.sh: it passes the app that was built, and turns away
# each altered copy of it below, with the problem named. One thing it does
# not try: an executable without the addresses of the test site.
#
#   ./check-app-test.sh <path to a built IamrealApp.app: Debug, for the simulator>
set -u

here=$(cd "$(dirname "$0")" && pwd)
app=${1:?usage: check-app-test.sh <path to IamrealApp.app>}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0

# expect <what> <words of the problem> [VAR=value ...]: check-app.sh fails on $tmp/app and names the problem.
expect() {
  what=$1
  words=$2
  shift 2
  if out=$(env "$@" "$here/check-app.sh" "$tmp/app/IamrealApp.app" 2>&1); then
    echo "not ok: $what: check-app.sh passed it"
    failed=1
  elif ! printf '%s\n' "$out" | grep -q -F "$words"; then
    echo "not ok: $what: check-app.sh did not say \"$words\" but:"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
  else
    echo "ok: $what"
  fi
}

# A fresh copy of the app to alter.
copy() {
  rm -rf "$tmp/app"
  mkdir "$tmp/app"
  cp -R "$app" "$tmp/app/IamrealApp.app"
}

if out=$("$here/check-app.sh" "$app" 2>&1); then
  echo "ok: the app as built"
else
  echo "not ok: the app as built:"
  printf '%s\n' "$out" | sed 's/^/    /'
  failed=1
fi

# The app as built is a Debug build: the development build (ADR-0040).
copy
plutil -replace CFBundleIdentifier -string tw.iamreal.app "$tmp/app/IamrealApp.app/Info.plist"
expect "the production app's identifier in a Debug build" "the identifier is tw.iamreal.app, not tw.iamreal.app.dev"

copy
plutil -replace CFBundleIdentifier -string tw.iamreal.app.test "$tmp/app/IamrealApp.app/Info.plist"
expect "the test app's identifier in a Debug build" "the identifier is tw.iamreal.app.test, not tw.iamreal.app.dev"

copy
expect "the development build's identifier in a Release build" "the identifier is tw.iamreal.app.dev, not tw.iamreal.app:" CONFIGURATION=Release

copy
expect "the development build's identifier in a TestApp build" "the identifier is tw.iamreal.app.dev, not tw.iamreal.app.test" CONFIGURATION=TestApp

copy
plutil -replace CFBundleIdentifier -string tw.iamreal.app.other "$tmp/app/IamrealApp.app/Info.plist"
expect "an identifier of no app" "the identifier is tw.iamreal.app.other"

copy
expect "a configuration of no app" "the configuration is Profile" CONFIGURATION=Profile

# The test app with its own identifier and name: the other app's name, and a build number out of its range.
as_test_app() {
  copy
  plutil -replace CFBundleIdentifier -string tw.iamreal.app.test "$tmp/app/IamrealApp.app/Info.plist"
  plutil -replace CFBundleDisplayName -string "島民證明 測試" "$tmp/app/IamrealApp.app/Info.plist"
  plutil -replace CFBundleVersion -string "$1" "$tmp/app/IamrealApp.app/Info.plist"
}
as_test_app 1000001
plutil -replace CFBundleDisplayName -string "島民證明 封測" "$tmp/app/IamrealApp.app/Info.plist"
expect "the production app's name in a TestApp build" "the name under the icon is 島民證明 封測, not \"島民證明 測試\"" CONFIGURATION=TestApp
as_test_app 999999
expect "a test app's build below 1,000,000" "the build is 999999, not from 1000000 to 1999999" CONFIGURATION=TestApp
as_test_app 2000000
expect "a test app's build of 2,000,000" "the build is 2000000, not from 1000000 to 1999999" CONFIGURATION=TestApp
as_test_app 1000001
printf 'https://iamreal.tw\0' >> "$tmp/app/IamrealApp.app/IamrealApp"
expect "the production site in a TestApp build" "the executable has the address of the production site, https://iamreal.tw" CONFIGURATION=TestApp

# The production app's build below 1,000,000, the development build's 2,000,000.
copy
plutil -replace CFBundleIdentifier -string tw.iamreal.app "$tmp/app/IamrealApp.app/Info.plist"
plutil -replace CFBundleDisplayName -string "島民證明 封測" "$tmp/app/IamrealApp.app/Info.plist"
plutil -replace CFBundleVersion -string 1000000 "$tmp/app/IamrealApp.app/Info.plist"
expect "a production app's build of 1,000,000" "the build is 1000000, not from 1 to 999999" CONFIGURATION=Release
copy
plutil -replace CFBundleVersion -string 1 "$tmp/app/IamrealApp.app/Info.plist"
expect "a development build's build of 1" "the build is 1, not 2000000,"

copy
plutil -replace CFBundleDisplayName -string "島民證明" "$tmp/app/IamrealApp.app/Info.plist"
expect "another name under the icon" "the name under the icon is 島民證明,"

copy
plutil -replace UIDeviceFamily -json '[1,2]' "$tmp/app/IamrealApp.app/Info.plist"
expect "an app for the iPad too" "UIDeviceFamily"

copy
rm "$tmp/app/IamrealApp.app/card_proof_rs4096.json"
expect "a circuit left out" "card_proof_rs4096.json"

copy
printf x >> "$tmp/app/IamrealApp.app/card_proof_rs2048.vk"
expect "another verification key" "card_proof_rs2048.vk"

copy
printf x >> "$tmp/app/IamrealApp.app/bn254_g2.dat"
expect "another CRS" "bn254_g2.dat"

copy
printf x >> "$tmp/app/IamrealApp.app/GenRyuMin2TW-B.otf"
expect "another typeface" "GenRyuMin2TW-B.otf in the app is not design/fonts/GenRyuMin2TW-B.otf"

copy
printf x >> "$tmp/app/IamrealApp.app/card-proof.json"
expect "other sentences of the card proof" "card-proof.json in the app is not design/copy/card-proof.json"

# The privacy manifest (issue #445).
copy
rm "$tmp/app/IamrealApp.app/PrivacyInfo.xcprivacy"
expect "no privacy manifest" "the app has no PrivacyInfo.xcprivacy"

copy
plutil -replace NSPrivacyTracking -bool true "$tmp/app/IamrealApp.app/PrivacyInfo.xcprivacy"
expect "a privacy manifest other than the one of App/" "PrivacyInfo.xcprivacy in the app is not App/PrivacyInfo.xcprivacy"

# The manifest of the sources itself changed: a copy of App/ with another one, which the app carries too.
alter_manifest() {
  copy
  rm -rf "$tmp/sources"
  cp -R "$here/App" "$tmp/sources"
  plutil "$@" "$tmp/sources/PrivacyInfo.xcprivacy"
  cp "$tmp/sources/PrivacyInfo.xcprivacy" "$tmp/app/IamrealApp.app/PrivacyInfo.xcprivacy"
}
alter_manifest -replace NSPrivacyTracking -bool true
expect "a manifest that says the app tracks" "does not say NSPrivacyTracking is false" IAMREAL_APP_SOURCES="$tmp/sources"

alter_manifest -insert NSPrivacyTrackingDomains.0 -string example.invalid
expect "a manifest with a tracking domain" "names tracking domains" IAMREAL_APP_SOURCES="$tmp/sources"

alter_manifest -remove NSPrivacyAccessedAPITypes.0
expect "user defaults not declared" "declares the required reason APIs [ FileTimestamp ], and the app uses [ FileTimestamp UserDefaults ]" IAMREAL_APP_SOURCES="$tmp/sources"

alter_manifest -remove NSPrivacyAccessedAPITypes.1
expect "the file timestamps the core's code can read not declared" "declares the required reason APIs [ UserDefaults ], and the app uses [ FileTimestamp UserDefaults ]" IAMREAL_APP_SOURCES="$tmp/sources"

alter_manifest -insert NSPrivacyAccessedAPITypes.0 -json '{"NSPrivacyAccessedAPIType":"NSPrivacyAccessedAPICategoryDiskSpace","NSPrivacyAccessedAPITypeReasons":["E174.1"]}'
expect "an API declared that the app does not use" "declares the required reason APIs [ DiskSpace FileTimestamp UserDefaults ]" IAMREAL_APP_SOURCES="$tmp/sources"

copy
rm -rf "$tmp/sources"
cp -R "$here/App" "$tmp/sources"
printf 'let uptime = ProcessInfo.processInfo.systemUptime\n' >> "$tmp/sources/Theme.swift"
expect "a source that reads the system's uptime, not declared" "and the app uses [ FileTimestamp SystemBootTime UserDefaults ]" IAMREAL_APP_SOURCES="$tmp/sources"

copy
printf ' ' >> "$tmp/app/IamrealApp.app/hang.json"
expect "another timeline of the demonstration" "hang.json in the app is not design/motion/hang.json"

copy
printf ' ' >> "$tmp/app/IamrealApp.app/sense.json"
expect "another timeline of where the card goes" "sense.json in the app is not design/motion/sense.json"

copy
rm "$tmp/app/IamrealApp.app/app.json"
expect "the app's sentences left out" "app.json in the app is not design/copy/app.json"

# A library that links AdSupport, put in the app.
copy
: > "$tmp/empty.c"
xcrun --sdk iphonesimulator clang -target arm64-apple-ios15.0-simulator -dynamiclib -framework AdSupport -o "$tmp/app/IamrealApp.app/Ads.dylib" "$tmp/empty.c"
expect "AdSupport linked" "AdSupport"

copy
mkdir "$tmp/app/IamrealApp.app/Frameworks"
expect "an embedded framework" "Frameworks"

# The executable with the address of the production site in it.
copy
for f in "$tmp/app/IamrealApp.app/IamrealApp.debug.dylib" "$tmp/app/IamrealApp.app/IamrealApp"; do
  [ -f "$f" ] && printf 'https://iamreal.tw\0' >> "$f"
done
expect "the address of the production site" "https://iamreal.tw"

copy
for f in "$tmp/app/IamrealApp.app/IamrealApp.debug.dylib" "$tmp/app/IamrealApp.app/IamrealApp"; do
  [ -f "$f" ] && printf 'https://data.iamreal.tw\0' >> "$f"
done
expect "the address of the production site's files" "https://data.iamreal.tw"

copy
expect "another environment" "IAMREAL_ENV_PRODUCTION" IAMREAL_ENVIRONMENT=IAMREAL_ENV_PRODUCTION

copy
printf x >> "$tmp/app/IamrealApp.app/bn254_g1_compressed_2p18.dat"
expect "another G1 of the CRS" "bn254_g1_compressed_2p18.dat"

copy
xcrun --sdk iphonesimulator clang -target arm64-apple-ios15.0-simulator -dynamiclib -framework AppTrackingTransparency -o "$tmp/app/IamrealApp.app/Track.dylib" "$tmp/empty.c"
expect "AppTrackingTransparency linked" "AppTrackingTransparency"

# The app as built is a Debug build for the simulator and holds the library
# of the tests: the same executable in an app for an iPhone, or in a Release
# build, is turned away.
copy
plutil -replace CFBundleSupportedPlatforms -json '["iPhoneOS"]' "$tmp/app/IamrealApp.app/Info.plist"
expect "the library of the tests in an app for an iPhone" "idc_testing_session_open"

copy
expect "the library of the tests in a Release build" "idc_testing_session_open" CONFIGURATION=Release

# Sources that do what the app must not.
copy
source_with() {
  rm -rf "$tmp/src"
  mkdir "$tmp/src"
  cp "$here/App/Bridge.h" "$tmp/src/Bridge.h"
  # The privacy manifest the app carries, and the one API of its list that App/ names.
  cp "$here/App/PrivacyInfo.xcprivacy" "$tmp/src/PrivacyInfo.xcprivacy"
  printf 'let defaults = UserDefaults.standard\n' > "$tmp/src/Defaults.swift"
  printf '%s\n' "$1" > "$tmp/src/X.swift"
}
source_with 'let id = UIDevice.current.identifierForVendor'
expect "identifierForVendor in the sources" "identifierForVendor" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'import AdSupport'
expect "AdSupport in the sources" "AdSupport" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'func f() { print("x") }'
expect "print in the sources" "print(" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'import os; let log = Logger()'
expect "a Logger in the sources" "Logger(" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'func f() { NSLog("x") }'
expect "NSLog in the sources" "NSLog(" IAMREAL_APP_SOURCES="$tmp/src"
source_with '@_silgen_name("bbapi") func bbapi()'
expect "a C function declared without the header" "@_silgen_name" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'func f() { FileHandle.standardError.write(Data()) }'
expect "standard error in the sources" "FileHandle.standard" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'func f() { fatalError("x") }'
expect "fatalError in the sources" "fatalError(" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'let x = 1'
printf 'void bbapi(void);\n' >> "$tmp/src/Bridge.h"
expect "a prototype written into Bridge.h" "Bridge.h is more than"  IAMREAL_APP_SOURCES="$tmp/src"
source_with 'let x = 1'
printf '#include <stdio.h>\n' >> "$tmp/src/Bridge.h"
expect "another header in Bridge.h" "Bridge.h is more than" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'let x = 1'
: > "$tmp/src/Other.h"
expect "a second header in the sources" "Other.h" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'let x = 1'
rm "$tmp/src/Bridge.h"
expect "no Bridge.h" "no Bridge.h" IAMREAL_APP_SOURCES="$tmp/src"

rm -rf "$tmp/project"
mkdir "$tmp/project"
sed 's|SWIFT_OBJC_BRIDGING_HEADER = App/Bridge.h;|SWIFT_OBJC_BRIDGING_HEADER = Other/Bridge.h;|' "$here/IamrealApp.xcodeproj/project.pbxproj" > "$tmp/project/project.pbxproj"
expect "another bridging header in the project" "bridging header" IAMREAL_PROJECT_FILE="$tmp/project/project.pbxproj"

# The app's target given the tests' header: the app would see idc_testing_session_open.
sed 's|SWIFT_OBJC_BRIDGING_HEADER = App/Bridge.h;|SWIFT_OBJC_BRIDGING_HEADER = Tests/Bridge.h;|' "$here/IamrealApp.xcodeproj/project.pbxproj" > "$tmp/project/project.pbxproj"
expect "the tests' bridging header for the app" "bridging header" IAMREAL_PROJECT_FILE="$tmp/project/project.pbxproj"

rm -rf "$tmp/tests"
mkdir "$tmp/tests"
cp "$here/Tests/Bridge.h" "$tmp/tests/Bridge.h"
printf 'void bbapi(void);\n' >> "$tmp/tests/Bridge.h"
expect "a prototype written into Tests/Bridge.h" "Tests/Bridge.h is more than" IAMREAL_TEST_SOURCES="$tmp/tests"

rm -rf "$tmp/config"
cp -R "$here/Config" "$tmp/config"
printf 'OTHER_SWIFT_FLAGS = -import-objc-header Other.h\n' >> "$tmp/config/Shared.xcconfig"
expect "another header through an .xcconfig" "bridging header" IAMREAL_CONFIG_DIR="$tmp/config"

# Names that only end like a forbidden one are let through.
source_with 'func f() { fingerprint(); publicInputs(); hexdump() }'
if out=$(IAMREAL_APP_SOURCES="$tmp/src" "$here/check-app.sh" "$tmp/app/IamrealApp.app" 2>&1); then
  echo "ok: fingerprint(, publicInputs( and hexdump( are not logs"
else
  echo "not ok: fingerprint(, publicInputs( and hexdump( are not logs:"
  printf '%s\n' "$out" | sed 's/^/    /'
  failed=1
fi
source_with 'func f() { Swift.print("x") }'
expect "Swift.print in the sources" "Swift.print(" IAMREAL_APP_SOURCES="$tmp/src"
source_with 'func f() { fputs("x", stderr) }'
expect "fputs to stderr in the sources" "fputs(" IAMREAL_APP_SOURCES="$tmp/src"

rm -rf "$tmp/project"
mkdir "$tmp/project"
sed 's/isa = PBXProject;/isa = PBXProject; packageReferences = ( XCRemoteSwiftPackageReference );/' "$here/IamrealApp.xcodeproj/project.pbxproj" > "$tmp/project/project.pbxproj"
expect "a Swift package in the project" "package" IAMREAL_PROJECT_FILE="$tmp/project/project.pbxproj"

exit $failed
