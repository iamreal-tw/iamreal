#!/bin/sh
# Downloads the part of Barretenberg's common reference string the app
# carries (the first 2^18 points of G1, compressed, and the point of G2:
# the files web/scripts/fetch-crs.mjs gets for the page) to vendor/crs/ and
# checks each against bundled.sha256. Prints that directory. A file whose
# hash does not match is not kept.
#
# The request carries nothing about the project or a person.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dir=$here/vendor/crs

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    set -- $(sha256sum "$1")
  else
    set -- $(shasum -a 256 "$1")
  fi
  echo "$1"
}

fetch() { # <name> <url> [<range>]
  want=$(grep -F "  $1" "$here/bundled.sha256") || { echo "fetch-crs: $1 is not in bundled.sha256" >&2; exit 1; }
  want=${want%% *}
  if [ -f "$dir/$1" ] && [ "$(sha256_of "$dir/$1")" = "$want" ]; then return; fi
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --user-agent crs-fetch \
    ${3:+--range "$3"} --output "$tmp/$1" "$2"
  if [ "$(sha256_of "$tmp/$1")" != "$want" ]; then
    echo "fetch-crs: the SHA-256 of $1 is not the one in bundled.sha256" >&2
    exit 1
  fi
  mv "$tmp/$1" "$dir/$1"
}

mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# 2^18 points of 32 bytes.
fetch bn254_g1_compressed_2p18.dat https://crs.aztec-cdn.foundation/g1_compressed.dat 0-8388607
fetch bn254_g2.dat https://crs.aztec-cdn.foundation/g2.dat
echo "$dir"
