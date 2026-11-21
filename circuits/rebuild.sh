#!/bin/sh
# Rebuilds the two card proof circuits from the source here and compares
# them, byte for byte, with what the repository publishes:
#
#   1. nargo (fetch-nargo.sh) compiles card_proof_rs2048 and card_proof_rs4096
#   2. web/scripts/strip-circuit.mjs keeps noir_version, abi and bytecode,
#      as for web/circuits/
#   3. each is compared with web/circuits/<circuit>.json
#   4. bb (find-bb.sh) writes its verification key with -t noir-recursive
#   5. each key is compared with verifier/vk/<circuit>.vk
#
# Every file is compared, and each one that differs is named with the
# SHA-256 of the committed file (expected) and of the rebuilt one (actual);
# then the command exits 1. It compares the files themselves, not a table
# of hashes. Needs `pnpm install` first. nargo fetches the Noir libraries
# into ~/nargo, and bb its common reference string into .crs/.
#
#   ./rebuild.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
nargo=$("$here/fetch-nargo.sh")
bb=$("$here/find-bb.sh")

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0

# compare <committed file, from the repository's root> <rebuilt file>
compare() {
  expected=$(sha256_of "$root/$1")
  actual=$(sha256_of "$2")
  if cmp -s "$root/$1" "$2"; then
    echo "same: $1 (sha256 $actual)"
  else
    echo "DIFFERENT: $1: expected sha256 $expected (committed), actual sha256 $actual (rebuilt)" >&2
    failed=1
  fi
}

"$nargo" --version
"$bb" --version
mkdir -p "$here/.crs"
for circuit in card_proof_rs2048 card_proof_rs4096; do
  (cd "$here" && "$nargo" compile --force --package "$circuit")
  node "$root/web/scripts/strip-circuit.mjs" "$here/target/$circuit.json" "$work/$circuit.json"
  compare "web/circuits/$circuit.json" "$work/$circuit.json"
  "$bb" write_vk -b "$work/$circuit.json" -o "$work/vk-$circuit" -c "$here/.crs" -t noir-recursive >"$work/bb.log" 2>&1 \
    || { cat "$work/bb.log" >&2; echo "rebuild: bb write_vk failed for $circuit" >&2; exit 1; }
  compare "verifier/vk/$circuit.vk" "$work/vk-$circuit/vk"
done

if [ "$failed" != 0 ]; then
  echo "rebuild: the rebuilt files differ from the committed ones" >&2
  exit 1
fi
echo "rebuild: the two circuits and the two verification keys are the committed ones"
