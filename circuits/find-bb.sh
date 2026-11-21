#!/bin/sh
# Prints the path of bb, Barretenberg's command-line program, for this
# machine: the native executable that comes in the package
# @aztec-foundation/bb.js 6.0.0 (package.json, pnpm-lock.yaml), the same bb
# web/ proves with. Checks its SHA-256 against bb.sha256 first, and prints
# nothing if it does not match. Needs `pnpm install` first.
#
#   ./find-bb.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=arm64-macos ;;
  Linux-x86_64) platform=amd64-linux ;;
  *) echo "find-bb: no bb in bb.sha256 for this machine" >&2; exit 1 ;;
esac

line=$(awk -v name="$platform/bb" '$2 == name' "$here/bb.sha256")
if [ "$(printf '%s\n' "$line" | grep -c .)" != 1 ]; then
  echo "find-bb: $platform/bb is not in bb.sha256 exactly once" >&2
  exit 1
fi
want=${line%% *}

bb=$here/node_modules/@aztec-foundation/bb.js/build/$platform/bb
[ -x "$bb" ] || { echo "find-bb: no $bb; run pnpm install first" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$bb")
else
  got=$(shasum -a 256 "$bb")
fi
if [ "${got%% *}" != "$want" ]; then
  echo "find-bb: the SHA-256 of $bb is ${got%% *}, not the one in bb.sha256 ($want)" >&2
  exit 1
fi
echo "$bb"
