#!/bin/sh
# Archives the store's build (ADR-0037: the Release configuration,
# tw.iamreal.app), unsigned, with the version and the build it is given, and
# checks the archive (check-archive.sh). The job of
# .github/workflows/upload-ios.yml that has the App Store Connect key signs
# it with Apple's cloud-managed certificate and uploads it; this job has no
# key, so nothing here signs.
#
#   ./archive.sh <path of the archive to make> <build> [<version>]
#
# <build> is the whole number App Store Connect tells builds apart by, higher
# each upload (ADR-0036): the workflow gives its run number. <version>, the
# one people see, is the date in Taiwan, as year.month.day with no zero in
# front (2026.11.5), unless it is given. Every upload of the same day has the
# same version and its own build: App Store Connect takes three integers and
# no more for the version (check-archive.sh), so there is no ".1" for a
# second upload of a day as ADR-0036 writes for the site's tags.
#
# Run build-core.sh device first: the archive links what it left.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
usage="usage: archive.sh <path of the archive to make> <build> [<version>]"
archive=${1:?$usage}
build=${2:?$usage}
version=${3:-$(TZ=Asia/Taipei date +%Y.%-m.%-d)}

# From where it was called: xcodebuild and the check run in ios/.
case $archive in /*) ;; *) archive=$(pwd)/$archive ;; esac
[ ! -e "$archive" ] || { echo "archive: $archive is already there" >&2; exit 1; }

cd "$here"
xcodebuild archive -project IamrealApp.xcodeproj -scheme IamrealApp -configuration Release \
  -destination generic/platform=iOS -archivePath "$archive" -derivedDataPath build \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" CODE_SIGNING_ALLOWED=NO
"$here/check-archive.sh" "$archive" "$version" "$build"
