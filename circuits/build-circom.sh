#!/bin/sh
# Builds the witness generators of the circom circuit the case-by-case
# comparison runs against (ADR-0012): PSE's zkID, at the commit in
# zkid-commit of the fork https://github.com/iamreal-tw/zkID. Fetches that
# one commit, without its history, into a temporary directory, runs what its
# wallet-unit-poc/circom/README.md says (`yarn install`, `yarn compile:all`),
# and keeps only what the tests and fuzz/ read, in .zkID/ (or the directory
# given), in the commit's layout:
#
#   wallet-unit-poc/circom/build/<circuit>/<circuit>_js/<circuit>.wasm
#   wallet-unit-poc/circom/build/<circuit>/<circuit>_js/witness_calculator.js
#   wallet-unit-poc/circom/circuits/components/poseidonP256Constants.circom
#
# for certChainRS2048, certChainRS4096 and userSigRS2048; a package.json
# saying the witness calculators are CommonJS (inside circuits/, whose
# package.json says "module", Node would read them as ES modules); and a file
# COMMIT with the commit. Everything else (the clone, node_modules, .r1cs, .sym, the
# C++ witness generators) is deleted. If the directory already holds a build
# of that commit, nothing is done. A directory this script did not make (one
# that is not empty and has no COMMIT) is refused, never deleted. tests/lib/run.mjs and fuzz/ look for it in
# .zkID/wallet-unit-poc/circom/build unless ZKID_CIRCOM_BUILD says where.
#
#   ./build-circom.sh [<directory>]
#
# Needs git, the circom compiler 2.2.3 on PATH (the version the commit's
# circomkit.json names) and corepack, which runs the yarn the commit's
# package.json names (yarn 1.22.22). `yarn install` keeps to yarn.lock and
# runs no install script. Takes a few minutes; most of it is circom.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
commit=$(cat "$here/zkid-commit")
dir=${1:-$here/.zkID}
circuits="certChainRS2048 certChainRS4096 userSigRS2048"

if [ -f "$dir/COMMIT" ] && [ "$(cat "$dir/COMMIT")" = "$commit" ]; then
  echo "build-circom: $dir already holds the build of $commit"
  exit 0
fi
# The build replaces $dir; only one this script made, or an empty one.
if [ -e "$dir" ] && { [ ! -d "$dir" ] || { [ ! -f "$dir/COMMIT" ] && [ -n "$(ls -A "$dir")" ]; }; }; then
  echo "build-circom: $dir is not empty and was not made by build-circom.sh (it has no COMMIT); give an empty or new directory" >&2
  exit 1
fi

case "$(circom --version 2>/dev/null)" in
  "circom compiler 2.2.3") ;;
  *) echo "build-circom: needs circom 2.2.3 on PATH, found: $(circom --version 2>&1 || true)" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git init --quiet "$work/zkID"
git -C "$work/zkID" fetch --quiet --depth 1 https://github.com/iamreal-tw/zkID "$commit"
git -C "$work/zkID" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
[ "$(git -C "$work/zkID" rev-parse HEAD)" = "$commit" ] || { echo "build-circom: fetched $(git -C "$work/zkID" rev-parse HEAD), not $commit" >&2; exit 1; }

src=$work/zkID/wallet-unit-poc/circom
(
  cd "$src"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  corepack yarn install --frozen-lockfile --ignore-scripts
  corepack yarn compile:all
)

rm -rf "$dir"
out=$dir/wallet-unit-poc/circom
for c in $circuits; do
  mkdir -p "$out/build/$c/${c}_js"
  cp "$src/build/$c/${c}_js/$c.wasm" "$src/build/$c/${c}_js/witness_calculator.js" "$out/build/$c/${c}_js/"
done
mkdir -p "$out/circuits/components"
cp "$src/circuits/components/poseidonP256Constants.circom" "$out/circuits/components/"
echo '{ "type": "commonjs" }' > "$out/package.json"
echo "$commit" > "$dir/COMMIT"
echo "build-circom: witness generators in $out/build"
