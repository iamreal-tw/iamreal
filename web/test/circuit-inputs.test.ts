// The circuit's inputs and the public inputs the device expects
// (spec/circuit-inputs.md) against spec/vectors/circuit-inputs.json.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asciiBytes, bytesOfHex } from "iamreal-protocol/bytes.ts";
import { dayOf } from "iamreal-protocol/date.ts";
import { scopedId } from "iamreal-protocol/scoped-id.ts";
import { checkCertificate } from "../src/certificate.ts";
import type { IssuerKey } from "../src/issuers.ts";
import { circuitInputs, circuitOf, expectedPublicInputs } from "../src/prover/inputs.ts";
import { poseidon } from "./bb.ts";
import { vectors } from "./vectors.ts";

// One spelling for comparing an input map: field elements and limbs as
// bigint, byte arrays as arrays of numbers.
const BYTE_ARRAYS = new Set(["tbs", "scope", "declaration_code"]);
function canonical(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (BYTE_ARRAYS.has(k)) out[k] = typeof v === "string" ? Array.from(bytesOfHex(v)) : v;
    else if (Array.isArray(v)) out[k] = v.map((x) => BigInt(x as string));
    else if (typeof v === "string") out[k] = BigInt(v);
    else out[k] = v;
  }
  return out;
}

/** The Taiwan date of a `current_time` (YYMMDD155959). */
function dayOfCurrentTime(t: number): number {
  const s = String(t);
  return dayOf(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)), Number(s.slice(4, 6)));
}

describe("circuit-inputs.json", async () => {
  const v = vectors("circuit-inputs.json");
  const p = await poseidon();
  const issuers: IssuerKey[] = v.issuers.map((i: { issuer: "G2" | "G3"; modulus_bits: 2048 | 4096; modulus: string }) => ({
    name: i.issuer,
    modulus: BigInt(i.modulus),
    bits: i.modulus_bits,
  }));

  test("there are cases for both circuits", () => {
    assert.deepEqual(new Set(v.cases.map((c: { circuit: string }) => c.circuit)), new Set(["card_proof_rs2048", "card_proof_rs4096"]));
  });

  for (const c of v.cases) {
    test(c.label, async () => {
      const checked = await checkCertificate(bytesOfHex(c.certificate), dayOfCurrentTime(c.current_time), issuers);
      assert.equal(checked.ok, true);
      if (!checked.ok) return;
      const cert = checked.cert;
      assert.equal(cert.issuer.name, c.issuer);
      assert.equal(circuitOf(cert), c.circuit);

      const scope = asciiBytes(c.scope_string);
      const code = asciiBytes(c.declaration_code);
      const scopeSignature = bytesOfHex(c.scope_signature);
      const tree = {
        root: BigInt(c.path.smt_root),
        siblings: c.path.smt_siblings.map((x: string) => BigInt(x)),
        isOld0: c.path.smt_is_old0,
        oldKey: BigInt(c.path.smt_old_key),
        oldValue: BigInt(c.path.smt_old_value),
      };
      const inputs = circuitInputs({
        cert,
        tree,
        currentTime: BigInt(c.current_time),
        scope,
        scopeSignature,
        declarationCode: code,
        declarationCodeSignature: bytesOfHex(c.declaration_code_signature),
      });
      assert.deepEqual(canonical(inputs), canonical(c.inputs));

      const id = await scopedId(scopeSignature, async (a, b) => p.hash2(a, b));
      const expected = expectedPublicInputs(cert, tree.root, BigInt(c.current_time), id, scope, code);
      assert.deepEqual(expected, c.public_inputs.map((x: string) => BigInt(x)));
    });
  }
});
