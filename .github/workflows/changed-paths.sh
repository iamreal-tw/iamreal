#!/usr/bin/env bash
# Which required checks of checks.yml a pull request calls for (#206): run by
# the changes job, the only place this is decided. Plain bash and git.
#
# Reads from the environment (checks.yml, the env of the changes job):
#   EVENT_NAME          the event's name
#   BASE_SHA, HEAD_SHA  on pull_request: the tip of the base branch and the
#                       pull request's head
#   GO_PATHS, TYPESCRIPT_PATHS, DEVICE_CORE_PATHS, ANDROID_PATHS
#                       each check's list, patterns separated by spaces: the
#                       lists of worker/test/workflows.ts
#   GITHUB_OUTPUT       where `<check>=true` or `<check>=false` is written
#
# On any event other than pull_request (the merge queue's merge_group) every
# check is `true`. On pull_request a check is `true` when a file the pull
# request changes matches a pattern of its list. The changed files are those
# of `git diff BASE...HEAD`: the pull request's head against its merge base
# with the base branch, as GitHub's own `paths` filter does ("three-dot
# diffs for pull requests", workflow syntax, on.<event>.paths). A renamed
# file counts under both names.
#
# A pattern is matched against the whole path from the repository's root,
# and is one of two forms: a path (that file only), or `<directory>/**`
# (every file under it). Any other pattern stops the script, as does
# anything else that goes wrong: the changes job then fails, and every
# required check fails with it instead of being skipped.
set -euf -o pipefail
export LC_ALL=C

checks="go typescript device-core android"
: "${GITHUB_OUTPUT:?}" "${EVENT_NAME:?}"

if [ "$EVENT_NAME" != pull_request ]; then
  for check in $checks; do
    echo "$check=true" >> "$GITHUB_OUTPUT"
    echo "$check: runs ($EVENT_NAME: every check runs)"
  done
  exit 0
fi

changed=$(mktemp)
git diff --name-only --no-renames -z "${BASE_SHA:?}...${HEAD_SHA:?}" > "$changed"

for check in $checks; do
  name=$(printf %s "$check" | tr 'a-z-' 'A-Z_')_PATHS
  patterns=${!name}
  [ -n "$patterns" ] || { echo "$name is empty" >&2; exit 1; }
  for pattern in $patterns; do
    case "${pattern%/\*\*}" in
      '' | *[!A-Za-z0-9._/-]*) echo "$name: a pattern that is not a path or <directory>/**: $pattern" >&2; exit 1 ;;
    esac
  done
  why=
  while IFS= read -r -d '' file; do
    for pattern in $patterns; do
      directory=${pattern%/\*\*}
      if [ "$directory" = "$pattern" ]; then
        if [ "$file" = "$pattern" ]; then why="$file"; fi
      else
        case "$file" in "$directory"/*) why="$file is in $pattern" ;; esac
      fi
      if [ -n "$why" ]; then break 2; fi
    done
  done < "$changed"
  if [ -n "$why" ]; then
    echo "$check=true" >> "$GITHUB_OUTPUT"
    echo "$check: runs ($why)"
  else
    echo "$check=false" >> "$GITHUB_OUTPUT"
    echo "$check: skipped (the pull request changes no file of $name)"
  fi
done
