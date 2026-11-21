#!/bin/sh
# Downloads nargo for this machine from Noir's GitHub release, checks its
# SHA-256 against nargo.sha256 and unpacks it to .tools/nargo/<platform>/.
# Prints the path of the `nargo` executable. Nothing is unpacked from an
# archive whose hash does not match.
#
# nargo.sha256 is the one place the version is written: each line is the
# SHA-256 of an archive and its path under
# https://github.com/noir-lang/noir/releases/download/, the release's tag
# first. nargo 1.0.0 is noirc 1.0.0+275d3ab1a5c916c6ea73e8d6b943f685f574500c,
# the compiler web/circuits/ was compiled with.
#
#   ./fetch-nargo.sh
#
# The request carries no project or personal information.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=aarch64-apple-darwin ;;
  Linux-x86_64) platform=x86_64-unknown-linux-gnu ;;
  *) echo "fetch-nargo: no nargo in nargo.sha256 for this machine" >&2; exit 1 ;;
esac

archive=noir-$platform.tar.gz
line=$(awk -v archive="$archive" '{ n = split($2, p, "/"); if (n == 2 && p[2] == archive) print }' "$here/nargo.sha256")
if [ "$(printf '%s\n' "$line" | grep -c .)" != 1 ]; then
  echo "fetch-nargo: $archive is not in nargo.sha256 exactly once" >&2
  exit 1
fi
want=${line%% *}
path=${line##* }

dir=$here/.tools/nargo/$platform
if [ -x "$dir/nargo" ] && [ -f "$dir/.sha256" ] && [ "$(cat "$dir/.sha256")" = "$line" ]; then
  echo "$dir/nargo"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --user-agent nargo-fetch \
  --output "$tmp/$archive" "https://github.com/noir-lang/noir/releases/download/$path"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$archive")
else
  got=$(shasum -a 256 "$tmp/$archive")
fi
if [ "${got%% *}" != "$want" ]; then
  echo "fetch-nargo: the SHA-256 of $archive is ${got%% *}, not the one in nargo.sha256 ($want)" >&2
  exit 1
fi

rm -rf "$dir"
mkdir -p "$dir"
tar -xzf "$tmp/$archive" -C "$dir"
[ -x "$dir/nargo" ] || { echo "fetch-nargo: no nargo in $archive" >&2; exit 1; }
echo "$line" > "$dir/.sha256"
echo "$dir/nargo"
