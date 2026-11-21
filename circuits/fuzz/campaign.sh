#!/bin/bash
# Runs a campaign: W workers in parallel on seed S, for M minutes (or N cases each).
#   ./campaign.sh SEED WORKERS MINUTES [extra run.mjs args]
set -eu
cd "$(dirname "$0")"
SEED=$1; W=$2; MIN=$3; shift 3
UNTIL=$(( $(date +%s) * 1000 + MIN * 60000 ))
mkdir -p logs
for i in $(seq 0 $((W - 1))); do
  node --max-old-space-size=4096 run.mjs --seed "$SEED" --start "$i" --step "$W" --id "$i" --until "$UNTIL" "$@" > "logs/$SEED-w$i.log" 2>&1 &
done
wait
echo "campaign $SEED done"
