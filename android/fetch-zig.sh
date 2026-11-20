#!/bin/sh
# Downloads Zig 0.15.1 for this machine from ziglang.org, checks its SHA-256
# against zig.sha256 and unpacks it to vendor/zig/<platform>/. Prints the
# path of the `zig` executable. Nothing is unpacked from an archive whose
# hash does not match.
#
# Zig 0.15.1 is the Zig Aztec builds Barretenberg 6.0.0 with; build-native.sh
# links the app's library with it (README.md, on the library).
set -eu

VERSION=0.15.1
here=$(cd "$(dirname "$0")" && pwd)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=aarch64-macos ;;
  Darwin-x86_64) platform=x86_64-macos ;;
  Linux-x86_64) platform=x86_64-linux ;;
  Linux-aarch64) platform=aarch64-linux ;;
  *) echo "fetch-zig: no Zig in zig.sha256 for this machine" >&2; exit 1 ;;
esac

name=zig-$platform-$VERSION
archive=$name.tar.xz
line=$(grep -F "  $archive" "$here/zig.sha256") || {
  echo "fetch-zig: $archive is not in zig.sha256" >&2
  exit 1
}

dir=$here/vendor/zig/$platform
if [ -x "$dir/$name/zig" ] && [ -f "$dir/.sha256" ] && [ "$(cat "$dir/.sha256")" = "$line" ]; then
  echo "$dir/$name/zig"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$tmp/$archive" "https://ziglang.org/download/$VERSION/$archive"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$archive")
else
  got=$(shasum -a 256 "$tmp/$archive")
fi
if [ "${got%% *}" != "${line%% *}" ]; then
  echo "fetch-zig: the SHA-256 of $archive is not the one in zig.sha256" >&2
  exit 1
fi

rm -rf "$dir"
mkdir -p "$dir"
tar -xJf "$tmp/$archive" -C "$dir"
[ -x "$dir/$name/zig" ] || { echo "fetch-zig: no zig in $archive" >&2; exit 1; }
echo "$line" > "$dir/.sha256"
echo "$dir/$name/zig"
