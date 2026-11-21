#!/usr/bin/env bash
# The version of the Android app that upload-android.yml builds (ADR-0036,
# the section on versions and tags): the name shown is the date in Taiwan (UTC+8, which has no
# daylight saving time), 2026.11.21, with .1, .2, ... from the day's second
# upload on; the build number (Android's versionCode) is the number of the
# workflow's run, which GitHub counts up by one for each run of a workflow.
#
#   android-version.sh <runs> <run number> <now>
#
# <runs> is GitHub's answer to the list of the workflow's successful runs
# on main (GET /repos/{owner}/{repo}/actions/workflows/{file}/runs), and
# <now> the time, as ISO 8601 in UTC (2026-11-21T03:00:00Z). An earlier
# upload of the day is a successful run created on the same date in Taiwan.
# Prints name=<name> and code=<code>, one to a line, for $GITHUB_OUTPUT.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: android-version.sh <runs> <run number> <now>" >&2
  exit 1
fi
runs=$1
code=$2
now=$3

if ! [[ $code =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo "the run number is not a whole number from 1 to 999999999: $code" >&2
  exit 1
fi

# The date in Taiwan of a time in UTC: eight hours later, as a date.
taiwan='fromdateiso8601 + 28800 | strftime("%Y.%m.%d")'
today=$(jq --null-input --raw-output --arg now "$now" "\$now | $taiwan")
earlier=$(jq --raw-output --arg today "$today" "[.workflow_runs[] | select(.created_at | $taiwan == \$today)] | length" "$runs")

if [ "$earlier" -eq 0 ]; then
  echo "name=$today"
else
  echo "name=$today.$earlier"
fi
echo "code=$code"
