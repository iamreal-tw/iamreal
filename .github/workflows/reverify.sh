#!/usr/bin/env bash
# The maintainer's daily re-verification of one proof log (ADR-0025), from its
# first record: run by each job of reverify.yml. Plain bash; what verifies
# is iamreal-verify (cmd/iamreal-verify), the command anyone runs, reading
# the published files and nothing else.
#
#   reverify.sh <test|production> <the address of the published files>
#
# Reads from the environment:
#   IAMREAL_BB      bb 6.0.0 (the workflow checked its SHA-256)
#   RUNNER_TEMP     where the common reference string and the output go
#   IAMREAL_VERIFY  iamreal-verify; $RUNNER_TEMP/iamreal-verify when not set
#
# iamreal-verify does the four things of ADR-0025 in one run: every record
# (its spelling, its proof, the record rules) with the fingerprints and hash
# lists published; every CRL of the archive against its index; every log
# file downloaded again, which is the hash of the old ones; the card state
# file against the state it computes. Its lines on standard error, which
# name each problem, go to the run's log as they come. Its standard output
# lists every record and every card: it is kept in a file, and printed here
# are its first lines (valid or broken at which line, how many records, the
# fingerprint) and each record that is not valid.
#
# Ends with iamreal-verify's exit code, so the job fails unless it is 0:
#   0  it passed
#   1  it did not pass: the maintainer does what ADR-0025 says
#   2  it could not be checked (a file could not be read): not a failure of
#      the proof log (ADR-0025), and the next run starts over
#   any other: iamreal-verify did not run to its end (not found, killed)
# The last line says which, and how long the run took: past an hour, the
# maintainer opens a ticket for the progress file (.github/README.md).
set -uf -o pipefail
export LC_ALL=C

if [ "$#" -ne 2 ] || [ -z "${RUNNER_TEMP:-}" ] || [ -z "${IAMREAL_BB:-}" ]; then
  echo "usage: reverify.sh <test|production> <the address of the published files>, with RUNNER_TEMP and IAMREAL_BB set" >&2
  exit 2
fi
proof_log=$1
data=$2
verify=${IAMREAL_VERIFY:-$RUNNER_TEMP/iamreal-verify}

# The common reference string iamreal-verify needs: the first point of
# BN254's G1, x = 1 and y = 2, 32 bytes each (verifier/README.md).
# iamreal-verify checks its SHA-256 before it uses it.
crs=$RUNNER_TEMP/crs
mkdir -p "$crs"
{ head -c 31 /dev/zero; printf '\001'; head -c 31 /dev/zero; printf '\002'; } > "$crs/bn254_g1.dat"

out=$RUNNER_TEMP/reverify-$proof_log.txt
start=$(date +%s)
"$verify" -bb "$IAMREAL_BB" -crs "$crs" -proof-log "$proof_log" -data "$data" > "$out"
code=$?
seconds=$(( $(date +%s) - start ))

head -n 3 "$out"
grep -E '^  [0-9]+ invalid ' "$out" || true

case $code in
  0) verdict="passed" ;;
  1) verdict="DID NOT PASS (the lines above say which record or file, and what; ADR-0025 says what the maintainer does)" ;;
  2) verdict="could not be checked (not a failure of the proof log; the next run starts over)" ;;
  *) verdict="did not run to its end (iamreal-verify was not found or was stopped; nothing is known about the proof log)" ;;
esac
echo "reverify: the $proof_log proof log at $data $verdict: exit code $code, $seconds seconds"
if [ "$seconds" -gt 3600 ]; then
  echo "reverify: more than an hour: open a ticket for the progress file (.github/README.md)"
fi
exit "$code"
