#!/usr/bin/env bash
# Runs Gradle, the command given (./gradlew and its arguments), and runs it
# again when it failed resolving a plugin or a library: three runs at most,
# with a wait of 30 seconds after the first and 60 after the second (#573).
# The android job of checks.yml, cache-android of cache.yml and the build
# jobs of upload-android.yml and upload-android-test.yml run Gradle through
# it, from android/.
#
# Why: on GitHub's runners Gradle, resolving from nothing, three times
# found the Kotlin plugin in none of its repositories, and passed when run
# again (2026-11-27 and 11-28; the plugin was on Maven Central, and judged a
# passing problem of the runner reaching it; .github/README.md). Only the
# messages Gradle prints for that are retried (RESOLVING, below), and only
# in its account of the failure, from its first "* What went wrong:" on, so
# that a line of the build's own output (a compiler's, a test's) does not
# count. Any other failure ends the step at once, with Gradle's exit status,
# and so does a failed dependency verification
# (android/gradle/verification-metadata.xml), which is not a network's
# failure and must not look like one.
#
# Gradle's output, stdout and stderr, goes to stdout as it comes and is kept
# in a temporary file, to be looked through when Gradle fails. Each retry
# prints one line, a GitHub warning, saying which run failed and which of
# the messages Gradle printed.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: gradle-retry.sh <command> [<argument>...]" >&2
  exit 2
fi

ATTEMPTS=3
# What Gradle prints when it could not get a plugin or a library, or a file
# of one, from the repositories.
RESOLVING=(
  "was not found in any of the following sources"
  "Could not resolve"
  "Could not GET"
  "Could not HEAD"
  "Could not download"
)
NOT_RETRIED="Dependency verification failed"

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

attempt=1
while :; do
  "$@" 2>&1 | tee "$output"
  status="${PIPESTATUS[0]}"
  [ "$status" -eq 0 ] && exit 0

  # Gradle's account of the failure: from its first "* What went wrong:" to the end.
  summary="$(sed -n '/^\* What went wrong:$/,$p' "$output")"
  reason=""
  if [ -n "$summary" ] && ! grep -qF -- "$NOT_RETRIED" <<<"$summary"; then
    for message in "${RESOLVING[@]}"; do
      if grep -qF -- "$message" <<<"$summary"; then
        reason="$message"
        break
      fi
    done
  fi
  [ -n "$reason" ] || exit "$status"
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::warning::gradle-retry: attempt $attempt of $ATTEMPTS failed resolving a plugin or a library (Gradle printed \"$reason\"); not running it again"
    exit "$status"
  fi

  wait_seconds=$((30 * attempt))
  echo "::warning::gradle-retry: attempt $attempt of $ATTEMPTS failed resolving a plugin or a library (Gradle printed \"$reason\"); running it again in $wait_seconds seconds"
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
