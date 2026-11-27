#!/bin/sh
# The test of check-archive.sh: it passes the archive that was built, and
# turns away each altered copy of it below, with the problem named.
#
#   ./check-archive-test.sh [--test-app] <path to IamrealApp.xcarchive> <version> <build>
#
# The archive is one archive.sh made, with --test-app when it was given it,
# and <version> and <build> are what it was given.
set -u

here=$(cd "$(dirname "$0")" && pwd)
usage="usage: check-archive-test.sh [--test-app] <path to IamrealApp.xcarchive> <version> <build>"
# The app archived, the other app that goes through a store, and the build number just out of the archived app's range (ADR-0040).
app_flag= identifier=tw.iamreal.app other=tw.iamreal.app.test out_of_range=1000000
if [ "${1-}" = --test-app ]; then
  app_flag=--test-app identifier=tw.iamreal.app.test other=tw.iamreal.app out_of_range=2000000
  shift
fi
archive=${1:?$usage}
archive=${archive%/}
version=${2:?$usage}
build=${3:?$usage}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0
a=$tmp/IamrealApp.xcarchive
app=$a/Products/Applications/IamrealApp.app

# expect <what> <words of the problem> [<version> <build>]: check-archive.sh fails on $a and names the problem.
expect() {
  what=$1
  words=$2
  if out=$("$here/check-archive.sh" $app_flag "$a" "${3-$version}" "${4-$build}" 2>&1); then
    echo "not ok: $what: check-archive.sh passed it"
    failed=1
  elif ! printf '%s\n' "$out" | grep -q -F -- "$words"; then
    echo "not ok: $what: check-archive.sh did not say \"$words\" but:"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
  else
    echo "ok: $what"
  fi
}

# A fresh copy of the archive to alter.
copy() {
  rm -rf "$a"
  cp -R "$archive" "$a"
}

if out=$("$here/check-archive.sh" $app_flag "$archive" "$version" "$build" 2>&1); then
  echo "ok: the archive as built"
else
  echo "not ok: the archive as built:"
  printf '%s\n' "$out" | sed 's/^/    /'
  failed=1
fi

# The numbers it was asked to carry.
copy
expect "another version than the one asked for" "the version is $version, not 2001.2.3" 2001.2.3 "$build"
copy
expect "another build than the one asked for" "the build is $build, not 999999" "$version" 999999
copy
plutil -replace CFBundleVersion -string 999999 "$app/Info.plist"
expect "the app's build changed after archiving" "the build is 999999"
copy
plutil -replace ApplicationProperties.CFBundleShortVersionString -string 2001.2.3 "$a/Info.plist"
expect "the archive's own record of the version changed" "the archive says the CFBundleShortVersionString is 2001.2.3"
copy
plutil -replace ApplicationProperties.CFBundleVersion -string 999999 "$a/Info.plist"
expect "the archive's own record of the build changed" "the archive says the CFBundleVersion is 999999"
copy
plutil -replace ApplicationProperties.CFBundleIdentifier -string tw.iamreal.app.dev "$a/Info.plist"
expect "the archive's own record of the identifier changed" "the archive says the CFBundleIdentifier is tw.iamreal.app.dev"
copy
plutil -replace ApplicationProperties.ApplicationPath -string Applications/Other.app "$a/Info.plist"
expect "the archive pointing at another app" "the archive says the ApplicationPath is Applications/Other.app"
copy
rm -rf "$app"
expect "no app in the archive" "no app at Products/Applications/IamrealApp.app"

# What App Store Connect takes: three integers for the version, one for the build.
copy
expect "a fourth number in the version" "not three integers" 2026.11.21.1 "$build"
copy
expect "a version with a zero in front" "not three integers" 2026.11.05 "$build"
copy
expect "a build that is not an integer" "not a whole number" "$version" 1.2

# The app archived, and nothing in it but the app.
copy
plutil -replace CFBundleIdentifier -string tw.iamreal.app.dev "$app/Info.plist"
expect "the development build's identifier" "the identifier is tw.iamreal.app.dev, not $identifier"
copy
plutil -replace CFBundleIdentifier -string $other "$app/Info.plist"
expect "the other app's identifier" "the identifier is $other, not $identifier"
copy
plutil -replace CFBundleVersion -string $out_of_range "$app/Info.plist"
plutil -replace ApplicationProperties.CFBundleVersion -string $out_of_range "$a/Info.plist"
expect "a build out of the app's range" "the build is $out_of_range, not from" "$version" $out_of_range
copy
mkdir -p "$app/PlugIns/IamrealAppTests.xctest"
: > "$app/PlugIns/IamrealAppTests.xctest/IamrealAppTests"
expect "the tests, with the fake card, in the app" "PlugIns"
copy
: > "$app/test-issuer.der"
expect "another file in the app" "test-issuer.der"
copy
printf 'FakeCard\0' >> "$app/IamrealApp"
expect "the fake card in the executable" "FakeCard"

copy
plutil -remove CFBundleIcons "$app/Info.plist"
expect "no icon named in Info.plist" "names no icon"
copy
rm "$app/Assets.car"
expect "no asset catalog" "Assets.car"

# check-app.sh, as for that app's configuration: the test site, no library of the tests.
copy
printf 'https://iamreal.tw\0' >> "$app/IamrealApp"
expect "the address of the production site" "https://iamreal.tw"
copy
printf 'idc_testing_session_open\0' >> "$app/IamrealApp"
expect "the library of the tests" "idc_testing_session_open"
# The entitlements the upload workflows sign the archive with (#532): the app domain, and only it.
copy
rm -rf "$tmp/config"
cp -R "$here/Config" "$tmp/config"
plutil -remove com\\.apple\\.developer\\.associated-domains "$tmp/config/IamrealApp.entitlements"
export IAMREAL_CONFIG_DIR="$tmp/config"
expect "no app domain in the entitlements the archive is signed with" "Config/IamrealApp.entitlements: the associated domains are none, not applinks:test-app.iamreal.tw"
unset IAMREAL_CONFIG_DIR
# Signed ad hoc as the upload workflows sign it, but with the development build's entitlements.
copy
codesign --force --sign - --timestamp=none --entitlements "$here/Config/IamrealAppDev.entitlements" "$app" 2>/dev/null
expect "the archive signed with the development build's entitlements" "the entitlements of the app's signature: the associated domains are none, not applinks:test-app.iamreal.tw"

exit $failed
