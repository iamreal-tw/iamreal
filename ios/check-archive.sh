#!/bin/sh
# Checks the archive archive.sh made, before it is handed to the job that
# signs it and uploads it to App Store Connect (.github/workflows/upload-ios.yml):
# that what goes to TestFlight is the store's build of ADR-0037 as it is
# until launch, and nothing else.
#
#   ./check-archive.sh <path to IamrealApp.xcarchive> <version> <build>
#
# What it checks:
# - the app is the store's build, tw.iamreal.app, with the version and the
#   build it was asked to carry, in the app and in the archive's own record
#   of it; the version is three integers with no zero in front (App Store
#   Connect takes no more: CFBundleShortVersionString is "three
#   period-separated integers") and the build one;
# - it has an icon (App Store Connect takes no build without one);
# - the app holds the executable, the files the app carries (README.md) and
#   what Xcode puts in every app, and nothing else: not the tests, which hold
#   the fake card (PlugIns/), not a key or a card of the tests; the
#   executable has no FakeCard in it;
# - check-app.sh, as for a Release build: it talks to the test site and not
#   the production one, it is not linked with the library of the tests (no
#   idc_testing_session_open, which trusts issuer keys a test gives it), the
#   files it carries are the repository's, iPhone only, no AdSupport.
#
# Which proof log the card signs for is not in the executable as anything it
# can find: both scope strings are in the core. It follows from the site: in
# App/AppEnvironment.swift the site and the proof log are set under the same
# compilation condition, and the test site's addresses are in the executable
# and the production site's are not, so the branch built is the test one;
# Tests/BuildTests.swift checks that this branch signs the test log's
# scope, iamreal-test:public:0.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
usage="usage: check-archive.sh <path to IamrealApp.xcarchive> <version> <build>"
archive=${1:?$usage}
archive=${archive%/}
version=${2:?$usage}
build=${3:?$usage}
app=$archive/Products/Applications/IamrealApp.app
problems=0

problem() {
  echo "check-archive: $*" >&2
  problems=1
}

value() {
  plutil -extract "$2" raw -o - "$1" 2>/dev/null || true
}

# The numbers. In the app's Info.plist, which is what App Store Connect reads,
# and in the archive's Info.plist, which is what Xcode's export reads.
echo "$version" | grep -q -E '^[1-9][0-9]*\.[1-9][0-9]*\.[1-9][0-9]*$' ||
  problem "the version asked for, $version, is not three integers with no zero in front"
echo "$build" | grep -q -E '^[1-9][0-9]*$' || problem "the build asked for, $build, is not a whole number above zero"
[ -d "$app" ] || problem "no app at Products/Applications/IamrealApp.app in $archive"
got=$(value "$app/Info.plist" CFBundleShortVersionString)
[ "$got" = "$version" ] || problem "the version is $got, not $version"
got=$(value "$app/Info.plist" CFBundleVersion)
[ "$got" = "$build" ] || problem "the build is $got, not $build"
got=$(value "$app/Info.plist" CFBundleIdentifier)
[ "$got" = tw.iamreal.app ] || problem "the identifier is $got, not tw.iamreal.app, the store's build"
for key in CFBundleIdentifier:tw.iamreal.app CFBundleShortVersionString:$version CFBundleVersion:$build ApplicationPath:Applications/IamrealApp.app; do
  got=$(value "$archive/Info.plist" "ApplicationProperties.${key%%:*}")
  [ "$got" = "${key#*:}" ] || problem "the archive says the ${key%%:*} is $got, not ${key#*:}"
done

# An icon: App Store Connect takes no build without one. The asset catalog
# App/Assets.xcassets, compiled into Assets.car, names it in Info.plist.
got=$(value "$app/Info.plist" CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName)
[ "$got" = AppIcon ] || problem "the app names no icon AppIcon in Info.plist (CFBundleIcons): App Store Connect takes no build without an icon"
[ -f "$app/Assets.car" ] || problem "the app has no Assets.car, where its icon is"

# Nothing in the app but these. Xcode's own: the executable, Info.plist,
# PkgInfo, the compiled asset catalog and the icons it writes out for older
# iOS (an iPad's too: an iPad can run an iPhone app in compatibility mode);
# the files the app carries (README.md, "包進 app 的檔案").
if [ -d "$app" ]; then
  extra=$(cd "$app" && find . -mindepth 1 | sed 's|^\./||' | grep -v -x -F \
    -e IamrealApp -e Info.plist -e PkgInfo \
    -e Assets.car -e AppIcon60x60@2x.png -e AppIcon76x76@2x~ipad.png \
    -e card_proof_rs2048.json -e card_proof_rs4096.json \
    -e card_proof_rs2048.vk -e card_proof_rs4096.vk \
    -e bn254_g1_compressed_2p18.dat -e bn254_g2.dat \
    -e card-proof.json -e app.json -e GenRyuMin2TW-B.otf -e hang.json -e sense.json \
    -e PrivacyInfo.xcprivacy || true)
  [ -z "$extra" ] || problem "the app holds what it should not: $(printf '%s\n' "$extra" | head -n 3 | tr '\n' ' ')"
  if LC_ALL=C grep -q -a -F FakeCard "$app/IamrealApp" 2>/dev/null; then
    problem "the executable has FakeCard in it, the fake card of the tests"
  fi
  # Every other check of a built app, as Xcode runs it for a Release build.
  CONFIGURATION=Release "$here/check-app.sh" "$app" || problems=1
fi

exit $problems
