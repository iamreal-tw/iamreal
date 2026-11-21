#!/usr/bin/env bash
# The version of the Android app that upload-android.yml builds (ADR-0036,
# the section on versions and tags, as #176 changed it): the name shown is
# the date in Taiwan (UTC+8, which has no daylight saving time), year,
# month and day with no zeros added (2026.11.5); the build number
# (Android's versionCode) is the number of the workflow's run, which GitHub
# counts up by one for each run of a workflow. Uploads on the same day have
# the same name and different build numbers, as the iOS app's do (the
# reason: .github/README.md, the section on uploading the Android app).
#
#   android-version.sh <run number> <now>
#
# <now> is the time, as ISO 8601 in UTC (2026-11-21T03:00:00Z). Prints
# name=<name> and code=<code>, one to a line, for $GITHUB_OUTPUT.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: android-version.sh <run number> <now>" >&2
  exit 1
fi
code=$1
now=$2

# "The greatest value Google Play allows for versionCode is 2100000000"
# (https://developer.android.com/studio/publish/versioning).
if ! [[ $code =~ ^[1-9][0-9]{0,9}$ ]] || [ "$code" -gt 2100000000 ]; then
  echo "the run number is not a versionCode Google Play takes (1 to 2100000000): $code" >&2
  exit 1
fi

# The date in Taiwan: eight hours after the time in UTC. gmtime's month counts from 0.
name=$(jq --null-input --raw-output --arg now "$now" \
  '$now | fromdateiso8601 + 28800 | gmtime | "\(.[0] | floor).\(.[1] + 1).\(.[2])"')

echo "name=$name"
echo "code=$code"
