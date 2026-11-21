#!/bin/sh
# Downloads the circom compiler for this machine from circom's GitHub
# release, checks its SHA-256 against circom.sha256 and puts it in
# .tools/circom/<platform>/. Prints the path of the `circom` executable.
# Nothing is put in place if the hash does not match.
#
# circom.sha256 is the one place the download is pinned: each line is the
# SHA-256 of a release asset and its path under
# https://github.com/iden3/circom/releases/download/, the release's tag
# first. build-circom.sh checks that the circom on PATH is 2.2.3, the
# version the circomkit.json of the commit in zkid-commit names; a change
# of version is made in both. Only x86-64 Linux, which CI runs on, is
# there; elsewhere install circom 2.2.3 yourself (README.md).
#
#   ./fetch-circom.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-amd64 ;;
  *) echo "fetch-circom: no circom in circom.sha256 for this machine; install circom 2.2.3 yourself" >&2; exit 1 ;;
esac

asset=circom-$platform
line=$(awk -v asset="$asset" '{ n = split($2, p, "/"); if (n == 2 && p[2] == asset) print }' "$here/circom.sha256")
if [ "$(printf '%s\n' "$line" | grep -c .)" != 1 ]; then
  echo "fetch-circom: $asset is not in circom.sha256 exactly once" >&2
  exit 1
fi
want=${line%% *}
path=${line##* }

dir=$here/.tools/circom/$platform
if [ -x "$dir/circom" ] && [ -f "$dir/.sha256" ] && [ "$(cat "$dir/.sha256")" = "$line" ]; then
  echo "$dir/circom"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$tmp/$asset" "https://github.com/iden3/circom/releases/download/$path"
got=$("$here/sha256.sh" "$tmp/$asset")
if [ "$got" != "$want" ]; then
  echo "fetch-circom: the SHA-256 of $asset is $got, not the one in circom.sha256 ($want)" >&2
  exit 1
fi

rm -rf "$dir"
mkdir -p "$dir"
mv "$tmp/$asset" "$dir/circom"
chmod +x "$dir/circom"
echo "$line" > "$dir/.sha256"
echo "$dir/circom"
