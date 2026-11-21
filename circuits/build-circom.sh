#!/bin/sh
# Builds the witness generators of the circom circuit the case-by-case
# comparison runs against (ADR-0012): PSE's zkID, at the commit in
# zkid-commit of the fork https://github.com/iamreal-tw/zkID. Clones it into
# .zkID/ (or the directory given), checks out that commit, and runs what its
# wallet-unit-poc/circom/README.md says: `yarn install`, `yarn compile:all`.
# tests/lib/run.mjs looks for the result in .zkID/wallet-unit-poc/circom/build
# unless ZKID_CIRCOM_BUILD says where.
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

case "$(circom --version 2>/dev/null)" in
  "circom compiler 2.2.3") ;;
  *) echo "build-circom: needs circom 2.2.3 on PATH, found: $(circom --version 2>&1 || true)" >&2; exit 1 ;;
esac

if [ ! -d "$dir/.git" ]; then
  git clone --quiet https://github.com/iamreal-tw/zkID "$dir"
fi
git -C "$dir" fetch --quiet origin "$commit"
git -C "$dir" -c advice.detachedHead=false checkout --quiet "$commit"
[ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ] || { echo "build-circom: $dir is not at $commit" >&2; exit 1; }
[ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] || { echo "build-circom: $dir has changes" >&2; exit 1; }

cd "$dir/wallet-unit-poc/circom"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack yarn install --frozen-lockfile --ignore-scripts
corepack yarn compile:all
echo "build-circom: witness generators in $dir/wallet-unit-poc/circom/build"
