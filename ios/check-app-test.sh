#!/bin/sh
# The test of check-app.sh: it passes the app that was built, and turns away
# each altered copy of it below, with the problem named. One thing it does
# not try: an executable without the addresses of the test site.
#
#   ./check-app-test.sh <path to a built IamrealApp.app, for the simulator>
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

copy
plutil -replace CFBundleIdentifier -string tw.iamreal.app "$tmp/app/IamrealApp.app/Info.plist"
expect "the identifier of the production app" "the identifier is tw.iamreal.app"

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

# Sources that do what the app must not.
copy
source_with() {
  rm -rf "$tmp/src"
  mkdir "$tmp/src"
  cp "$here/App/Bridge.h" "$tmp/src/Bridge.h"
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

rm -rf "$tmp/project"
mkdir "$tmp/project"
sed 's/isa = PBXProject;/isa = PBXProject; packageReferences = ( XCRemoteSwiftPackageReference );/' "$here/IamrealApp.xcodeproj/project.pbxproj" > "$tmp/project/project.pbxproj"
expect "a Swift package in the project" "package" IAMREAL_PROJECT_FILE="$tmp/project/project.pbxproj"

exit $failed
