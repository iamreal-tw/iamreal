#!/bin/bash
# Builds deliberately broken copies of the Noir circuits, one check removed
# each, under $W/mutants/<name>/target. The fuzzer must report every one.
set -eu
W=$(cd "$(dirname "$0")/../.." && pwd)
SRC=$W/zkid-noir
export PATH=$SRC/.tools/nargo:$PATH
mk() {
  name=$1; file=$2; from=$3; to=$4
  d=$W/mutants/$name
  rm -rf "$d"; mkdir -p "$d"
  cp -R "$SRC/Nargo.toml" "$SRC/lib" "$SRC/card_proof_rs2048" "$SRC/card_proof_rs4096" "$SRC/comparison" "$d/"
  mkdir -p "$d/tests" && cp -R "$SRC/tests/probes" "$d/tests/"   # workspace members
  python3 - "$d/$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1:]
s = open(p).read()
assert s.count(a) == 1, (p, a)
open(p, "w").write(s.replace(a, b))
PY
  (cd "$d" && nargo compile >/dev/null 2>&1 && echo "$name compiled") || echo "$name FAILED"
}
mk no-keyusage lib/src/der.nr "expect(tbs, exponent + 77, KEY_USAGE);" ""
mk no-end-bound lib/src/der.nr "assert(exponent + 168 <= tbs_len);" ""
mk no-sig-in-field lib/src/rsa.nr "signature.validate_in_field();" ""
mk no-yy50 lib/src/der.nr "assert(tbs[offset] < 53);" ""
mk no-oldkey-ne lib/src/smt.nr "assert(is_old0 | (old_key != key));" ""
mk no-scope-kind lib/src/lib.nr 'assert(is_scope_kind(scope[0]), "not a scope string");' ""
mk subject-81-any lib/src/der.nr "assert(!is_long | (b2 >= 128));" ""
# Added with the fixes after the review. The card proof still rejects a short
# key (the library checks it again); the certificate part alone must not accept.
mk no-key-top-bit lib/src/der.nr "assert(modulus[0] >= 0x80);" ""
