#!/bin/sh
# Downloads Aztec's prebuilt static library of Barretenberg 6.0.0 for one
# platform, checks its SHA-256 against barretenberg.sha256 and unpacks it to
# vendor/barretenberg/<platform>/. Prints that directory: it is the value of
# BB_LIB_DIR (README.md). Nothing is unpacked from an archive whose hash
# does not match.
#
#   ./fetch-barretenberg.sh              the platform of this machine
#   ./fetch-barretenberg.sh arm64-ios    one of the names in barretenberg.sha256
set -eu

VERSION=6.0.0
here=$(cd "$(dirname "$0")" && pwd)

if [ $# -ge 1 ]; then
  platform=$1
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=arm64-darwin ;;
    Darwin-x86_64) platform=amd64-darwin ;;
    Linux-x86_64) platform=amd64-linux ;;
    Linux-aarch64) platform=arm64-linux ;;
    *) echo "fetch-barretenberg: no prebuilt library for this machine" >&2; exit 1 ;;
  esac
fi

archive=barretenberg-static-$platform.tar.gz
line=$(grep "  $archive\$" "$here/barretenberg.sha256") || {
  echo "fetch-barretenberg: $archive is not in barretenberg.sha256" >&2
  exit 1
}

dir=$here/vendor/barretenberg/$platform
if [ -f "$dir/libbb-external.a" ] && [ -f "$dir/.sha256" ] && [ "$(cat "$dir/.sha256")" = "$line" ]; then
  echo "$dir"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$tmp/$archive" \
  "https://github.com/AztecProtocol/barretenberg/releases/download/v$VERSION/$archive"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$archive")
else
  got=$(shasum -a 256 "$tmp/$archive")
fi
if [ "${got%% *}" != "${line%% *}" ]; then
  echo "fetch-barretenberg: the SHA-256 of $archive is not the one in barretenberg.sha256" >&2
  exit 1
fi

rm -rf "$dir"
mkdir -p "$dir"
tar -xzf "$tmp/$archive" -C "$dir"
[ -f "$dir/libbb-external.a" ] || { echo "fetch-barretenberg: no libbb-external.a in $archive" >&2; exit 1; }
echo "$line" > "$dir/.sha256"
echo "$dir"
