// Checks the fuzzer's reference judgment against the hand-written expectations
// of the existing case-by-case comparison (zkid-noir/tests/cases.mjs): every
// case it can express must get the same accept / reject.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NOIR_ROOT } from "../lib/common.mjs";
import { isCodeKind, isScopeKind, rsaVerify, walk, is2048 } from "../lib/oracle.mjs";

const { buildCases } = await import(pathToFileURL(join(NOIR_ROOT, "tests", "cases.mjs")).href);
const { cases } = buildCases();
let same = 0, differ = 0, skipped = 0;
for (const c of cases) {
  let got;
  if (c.kind === "chain2048" || c.kind === "chain4096") {
    if (c.serialNumber !== undefined) { skipped++; continue; } // circom-only input
    got = walk(c.tbs, c.currentTime).ok && rsaVerify(c.ca.modulus, c.signature, c.tbs) && !c.shiftLimb;
  } else if (c.kind === "scope" || c.kind === "code") {
    if (c.message.length !== 31) { got = false; }
    else got = rsaVerify(c.key.modulus, c.signature, c.message) && is2048(c.key.modulus) && !c.shiftLimb
      && (c.kind === "scope" ? isScopeKind(c.message[0]) : isCodeKind(c.message[0]));
  } else { skipped++; continue; }
  if (got === c.expect) same++;
  else { differ++; console.log("DIFFERS:", c.source, c.title, "expected", c.expect, "reference", got); }
}
console.log(`${same} same, ${differ} different, ${skipped} not expressible`);
