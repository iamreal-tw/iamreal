#!/bin/sh
# Downloads the part of Barretenberg's common reference string a card proof
# needs (the first 2^18 points of G1, compressed, and the point of G2),
# checks each file against crs.sha256, and prints the directory that holds
# them. These are the two files an app carries (ADR-0035); here they are
# for the tests that make a proof. The same files as web/scripts/fetch-crs.mjs.
#
#   ./fetch-crs.sh
#
# The request carries no project or personal information.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dir=$here/vendor/crs

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fetch <name> <url> [<last byte>]
fetch() {
  name=$1
  line=$(awk -v name="$name" '$2 == name' "$here/crs.sha256")
  if [ "$(printf '%s\n' "$line" | grep -c .)" != 1 ]; then
    echo "fetch-crs: $name is not in crs.sha256 exactly once" >&2
    exit 1
  fi
  want=${line%% *}
  if [ -f "$dir/$name" ] && [ "$(sha256_of "$dir/$name")" = "$want" ]; then
    return
  fi
  tmp=$(mktemp)
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --user-agent crs-fetch ${3:+--range "0-$3"} --output "$tmp" "$2"
  if [ "$(sha256_of "$tmp")" != "$want" ]; then
    rm -f "$tmp"
    echo "fetch-crs: the SHA-256 of $name is not the one in crs.sha256" >&2
    exit 1
  fi
  mv "$tmp" "$dir/$name"
}

mkdir -p "$dir"
# 2^18 points of 32 bytes.
fetch bn254_g1_compressed_2p18.dat https://crs.aztec-cdn.foundation/g1_compressed.dat 8388607
fetch bn254_g2.dat https://crs.aztec-cdn.foundation/g2.dat
echo "$dir"
