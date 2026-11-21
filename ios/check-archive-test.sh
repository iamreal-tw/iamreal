#!/bin/sh
# The test of check-archive.sh: it passes the archive that was built, and
# turns away each altered copy of it below, with the problem named.
#
#   ./check-archive-test.sh <path to IamrealApp.xcarchive> <version> <build>
#
# The archive is one archive.sh made, and <version> and <build> are what it
# was given.
set -u

here=$(cd "$(dirname "$0")" && pwd)
archive=${1:?usage: check-archive-test.sh <path to IamrealApp.xcarchive> <version> <build>}
archive=${archive%/}
version=${2:?usage: check-archive-test.sh <path to IamrealApp.xcarchive> <version> <build>}
build=${3:?usage: check-archive-test.sh <path to IamrealApp.xcarchive> <version> <build>}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0
a=$tmp/IamrealApp.xcarchive
app=$a/Products/Applications/IamrealApp.app

# expect <what> <words of the problem> [<version> <build>]: check-archive.sh fails on $a and names the problem.
expect() {
  what=$1
  words=$2
  if out=$("$here/check-archive.sh" "$a" "${3-$version}" "${4-$build}" 2>&1); then
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

if out=$("$here/check-archive.sh" "$archive" "$version" "$build" 2>&1); then
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

# What App Store Connect takes: three integers for the version, one for the build.
copy
expect "a fourth number in the version" "not three integers" 2026.11.21.1 "$build"
copy
expect "a version with a zero in front" "not three integers" 2026.11.05 "$build"
copy
expect "a build that is not an integer" "not a whole number" "$version" 1.2

# The store's build, and nothing in it but the app.
copy
plutil -replace CFBundleIdentifier -string tw.iamreal.app.dev "$app/Info.plist"
expect "the development build's identifier" "tw.iamreal.app.dev"
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

# check-app.sh, as for a Release build: the test site, no library of the tests.
copy
printf 'https://iamreal.tw\0' >> "$app/IamrealApp"
expect "the address of the production site" "https://iamreal.tw"
copy
printf 'idc_testing_session_open\0' >> "$app/IamrealApp"
expect "the library of the tests" "idc_testing_session_open"

exit $failed
