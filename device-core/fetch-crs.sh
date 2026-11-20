#!/bin/sh
# Downloads the part of Barretenberg's common reference string the apps
# carry (ADR-0035): the first 2^18 points of G1, compressed, and the point
# of G2. Checks each file's SHA-256 against crs.sha256 and writes it to
# vendor/crs/. Prints that directory. A file whose hash does not match is
# not written.
#
# The same two files, with the same hashes, as web/scripts/fetch-crs.mjs
# downloads for the page. The requests carry nothing of this project.
#
#   ./fetch-crs.sh
set -eu

POINTS=262144 # 2^18, enough for both circuits (web/src/prover/artifacts.ts)
here=$(cd "$(dirname "$0")" && pwd)
dir=$here/vendor/crs

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# fetch <name> <url> <bytes>: the first <bytes> bytes of <url>, as vendor/crs/<name>.
fetch() {
  name=$1
  url=$2
  size=$3
  line=$(grep -F "  $name" "$here/crs.sha256") || {
    echo "fetch-crs: $name is not in crs.sha256" >&2
    exit 1
  }
  want=${line%% *}
  if [ -f "$dir/$name" ] && [ "$(sha256_of "$dir/$name")" = "$want" ]; then
    return 0
  fi
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --user-agent crs-fetch --range "0-$((size - 1))" --max-filesize "$size" \
    --output "$tmp/$name" "$url"
  if [ "$(wc -c < "$tmp/$name" | tr -d ' ')" != "$size" ]; then
    echo "fetch-crs: $name is not $size bytes" >&2
    exit 1
  fi
  if [ "$(sha256_of "$tmp/$name")" != "$want" ]; then
    echo "fetch-crs: the SHA-256 of $name is not the one in crs.sha256" >&2
    exit 1
  fi
  mkdir -p "$dir"
  mv "$tmp/$name" "$dir/$name"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch bn254_g1_compressed_2p18.dat https://crs.aztec-cdn.foundation/g1_compressed.dat $((POINTS * 32))
fetch bn254_g2.dat https://crs.aztec-cdn.foundation/g2.dat 128
echo "$dir"
