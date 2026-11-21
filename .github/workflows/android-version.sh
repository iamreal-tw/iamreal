#!/usr/bin/env bash
# The version of the Android app that upload-android.yml builds (ADR-0036,
# the section on versions and tags): the name shown is the date in Taiwan
# (UTC+8, which has no daylight saving time), 2026.11.21, with .1, .2, ...
# from the day's second run on; the build number (Android's versionCode) is
# the number of the workflow's run, which GitHub counts up by one for each
# run of a workflow.
#
#   android-version.sh <runs> <run number> <now>
#
# <runs> is GitHub's answer to the list of the workflow's runs on main
# (GET /repos/{owner}/{repo}/actions/workflows/{file}/runs), and <now> the
# time, as ISO 8601 in UTC (2026-11-21T03:00:00Z). An earlier run of the day
# is a run with a smaller number created on the same date in Taiwan, however
# it ended: one that failed at the upload may still have had its bundle put
# on Google Play by hand (.github/README.md), so it counts, and no two builds
# of a day have the same name. This run is in the list too, while it runs.
# Prints name=<name> and code=<code>, one to a line, for $GITHUB_OUTPUT.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: android-version.sh <runs> <run number> <now>" >&2
  exit 1
fi
runs=$1
code=$2
now=$3

# "The greatest value Google Play allows for versionCode is 2100000000"
# (https://developer.android.com/studio/publish/versioning).
if ! [[ $code =~ ^[1-9][0-9]{0,9}$ ]] || [ "$code" -gt 2100000000 ]; then
  echo "the run number is not a versionCode Google Play takes (1 to 2100000000): $code" >&2
  exit 1
fi

# The date in Taiwan of a time in UTC: eight hours later, as a date.
taiwan='fromdateiso8601 + 28800 | strftime("%Y.%m.%d")'
today=$(jq --null-input --raw-output --arg now "$now" "\$now | $taiwan")
number='if (.run_number | type) == "number" then .run_number else error("a run without a number") end'
earlier=$(jq --raw-output --arg today "$today" --argjson code "$code" \
  "[.workflow_runs[] | select(($number) < \$code and (.created_at | $taiwan) == \$today)] | length" "$runs")

if [ "$earlier" -eq 0 ]; then
  echo "name=$today"
else
  echo "name=$today.$earlier"
fi
echo "code=$code"
