#!/bin/zsh
# Writes the verification key of each card proof circuit to
# target/vk/<circuit>/vk and prints its SHA-256. Needs `nargo compile` first.
# The verifier target is noir-recursive (Poseidon2 transcript, zero-knowledge),
# the same settings bb.js uses by default.
ROOT=${0:A:h:h}
export PATH=$ROOT/.tools/nargo:$ROOT/.tools/bb:$PATH
set -e
for circuit in card_proof_rs2048 card_proof_rs4096; do
  mkdir -p $ROOT/target/vk/$circuit $ROOT/.crs
  bb write_vk -b $ROOT/target/$circuit.json -o $ROOT/target/vk/$circuit -c $ROOT/.crs -t noir-recursive >/dev/null 2>&1 \
    || { echo "bb write_vk failed for $circuit" >&2; exit 1; }
  echo "$(shasum -a 256 $ROOT/target/vk/$circuit/vk | cut -d' ' -f1)  $circuit"
done
