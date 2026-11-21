#!/bin/sh
# Prints the SHA-256 of a file, 64 lowercase hex digits, and nothing else:
# with sha256sum where there is one (Linux), shasum otherwise (macOS). The
# one place the scripts of circuits/ compute a SHA-256.
#
#   ./sha256.sh <file>
set -eu
[ -f "$1" ] || { echo "sha256: no file $1" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  out=$(sha256sum "$1")
else
  out=$(shasum -a 256 "$1")
fi
echo "${out%% *}"
