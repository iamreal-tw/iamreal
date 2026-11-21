#!/bin/bash
# Self-test of the fuzzer. Runs Noir-only cases (no circom) against the real
# circuits and against each mutant (selftest/make-mutants.sh): N random cases
# plus 40 cases of each focused mutation. The real circuits must give no
# finding; each mutant must give at least one.
set -u
F=$(cd "$(dirname "$0")/.." && pwd)
W=${FUZZ_WORK:-${TMPDIR:-/tmp}/circuits-fuzz}   # as make-mutants.sh
N=${1:-200}
OUT=$W/selftest-out
rm -rf "$OUT"; mkdir -p "$OUT"
FOCUS="chain:keyusage card:truncate-keep-tail sig:sig-plus-n chain:time chain:smt card:kind-swap chain:names chain:key card:scope-uppercase"
run() {
  name=$1; target=$2
  for i in 0 1 2 3; do
    node "$F/run.mjs" --seed "self-$name" --start $i --step 4 --count $((N / 4)) --id $i --no-circom --noir-target "$target" --out "$OUT/$name" > "$OUT/$name-w$i.log" 2>&1 &
  done
  for fm in $FOCUS; do
    fam=${fm%%:*}; mut=${fm#*:}
    node "$F/run.mjs" --seed "self-$name-$mut" --count 40 --id f --only "$fam" --mutation "$mut" --no-circom --noir-target "$target" --out "$OUT/$name" > "$OUT/$name-$mut.log" 2>&1 &
  done
  wait
  n=$(cat "$OUT/$name"/results/*/*.jsonl | wc -l | tr -d ' ')
  f=$(ls "$OUT/$name/findings" | wc -l | tr -d ' ')
  by=$(cd "$OUT/$name/findings" 2>/dev/null && ls | sed -E 's/^self-[a-z0-9-]*-?([a-z0-9-]*)-[0-9]+\.json$/\1/' | sort | uniq -c | tr '\n' ' ')
  echo "$name: $n cases, $f with findings  [$by]"
}
run baseline "$F/../target"
for m in "$W"/mutants/*/; do run "$(basename "$m")" "$m/target"; done
