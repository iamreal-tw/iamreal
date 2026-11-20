// Writes spec/vectors/circuit-inputs.json and spec/vectors/revocation-tree.json
// from the test fixtures (test/fixtures/). Run in web/:
//
//   node --experimental-strip-types test/generate/circuit-inputs.ts
//
// Each run makes new test keys, so every certificate, CRL file and
// signature changes; the serial numbers are fixed, so the roots and paths do
// not. The private keys are not kept.
//
// What is checked here, not only written:
// - the circuits (circuits/*.json) accept every case's input map: noir_js
//   executes them, so every assertion of the circuit holds, and the public
//   outputs it computes (nullifier, scope_packed, declaration_code_packed)
//   equal the expected public inputs;
// - every path leads back to the root (the circuit's own check, recomputed
//   by checkAbsence) and comes out the same built in 1, 2 and 4 parts.
// The paths are checked against `iamreal-crl prove` by the Go tests
// (cmd/iamreal-crl/vectors_test.go).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Noir } from "@noir-lang/noir_js";
import { asciiBytes, hexOf } from "iamreal-protocol/bytes.ts";
import { currentTime } from "iamreal-protocol/challenge.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import { declarationCode } from "iamreal-protocol/declaration-code.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { scopedId } from "iamreal-protocol/scoped-id.ts";
import { checkCertificate } from "../../src/certificate.ts";
import { buildWith } from "../../src/crl/build.ts";
import { usableCrl } from "../../src/crl/crl.ts";
import { type AbsenceProof, checkAbsence } from "../../src/crl/tree.ts";
import type { IssuerName } from "../../src/issuers.ts";
import { circuitInputs, circuitOf, expectedPublicInputs } from "../../src/prover/inputs.ts";
import { poseidon } from "../bb.ts";
import { makeCrl } from "../fixtures/crls.ts";
import { signWith } from "../fixtures/der-build.ts";
import { type World, makeWorld, randomSerials } from "../fixtures/world.ts";

const GENERATED_BY = "web/test/generate/circuit-inputs.ts";
const field = (x: bigint): string => "0x" + x.toString(16).padStart(64, "0");
const repo = (path: string): URL => new URL(`../../../${path}`, import.meta.url);

const p = await poseidon();
const hash2 = async (a: bigint, b: bigint): Promise<bigint> => p.hash2(a, b);
const hash3 = async (a: bigint, b: bigint, c: bigint): Promise<bigint> => p.hash3(a, b, c);

const day = parseDay("2026-11-16")!;
const thisUpdate = new Date("2026-11-15T16:30:00Z");
// The example challenge of spec/vectors/declaration-code.json.
const challenge = "2026-11-16.000G40R40M30E209185GR38E1W";

const g3 = await makeWorld({ issuer: "G3" });
// A longer name, so that the two certificates differ in length.
const g2 = await makeWorld({ issuer: "G2", name: "測試用戶之二" });
const cardSerial = g3.serial;
const issuers = (["G2", "G3"] as const).map((name) => ({ issuer: name, modulus_bits: g3.issuerKeys[name].bits, modulus: "0x" + g3.issuerKeys[name].modulus.toString(16) }));

// ---------------------------------------------------------------- the tree

interface CrlSpec {
  name: string;
  what: string;
  issuer: IssuerName;
  serials: bigint[];
}

// The card's serial number shares its lowest 40 bits with these keys, so its
// path runs past the random keys to depth 40.
const near = (bits: number[]): bigint => bits.reduce((k, b) => k ^ (1n << BigInt(b)), cardSerial);
const random = randomSerials(200, 7n);
const crlSpecs: CrlSpec[] = [
  {
    name: "g3-leaf",
    what: "200 serials like MOICA's, and one that shares the card's lowest 40 bits: the card's path ends at that leaf",
    issuer: "G3",
    serials: [...random, near([40])],
  },
  {
    name: "g2-empty",
    what: "200 serials like MOICA's, and two that share the card's lowest 40 bits and differ from it in bit 40: past the random keys the card's path runs on with zero siblings to depth 40, and ends in an empty subtree at depth 41",
    issuer: "G2",
    serials: [...randomSerials(200, 11n), near([40]), near([40, 41])],
  },
  {
    name: "g3-empty-list",
    what: "a CRL without revokedCertificates",
    issuer: "G3",
    serials: [],
  },
];

interface Path {
  smt_root: string;
  smt_siblings: string[];
  smt_old_key: string;
  smt_old_value: string;
  smt_is_old0: boolean;
}

const pathOf = (proof: AbsenceProof): Path => ({
  smt_root: field(proof.root),
  smt_siblings: proof.siblings.map(field),
  smt_old_key: field(proof.oldKey),
  smt_old_value: field(proof.oldValue),
  smt_is_old0: proof.isOld0,
});

const crls = new Map<string, { der: Uint8Array; root: bigint; keys: Uint32Array; count: number; spec: CrlSpec }>();
for (const [i, s] of crlSpecs.entries()) {
  const issuerKey = g3.issuerKeys[s.issuer];
  const der = await makeCrl({ issuer: issuerKey, serials: s.serials, crlNumber: 2026111600n + BigInt(i), thisUpdate });
  const crl = await usableCrl(der, issuerKey.publicKey, issuerKey.bits);
  const r = await buildWith([p.runner()], crl.keys, crl.count, 0n);
  crls.set(s.name, { der, root: r.inTree ? r.root : r.proof.root, keys: crl.keys, count: crl.count, spec: s });
}

async function pathOrInTree(crlName: string, serial: bigint): Promise<{ inTree: true } | { inTree: false; proof: AbsenceProof }> {
  const c = crls.get(crlName)!;
  const results = [];
  for (const n of [1, 2, 4]) results.push(await buildWith(Array.from({ length: n }, () => p.runner()), c.keys, c.count, serial));
  for (const r of results.slice(1)) assert.deepEqual(r, results[0]);
  const r = results[0]!;
  if (r.inTree) return { inTree: true };
  assert.equal(r.proof.root, c.root);
  assert.equal(await checkAbsence(r.proof, serial, hash2, hash3), true);
  return { inTree: false, proof: r.proof };
}

const treeCases: { label: string; crl: string; serial: bigint; expect: "old_leaf" | "empty" | "in_tree" }[] = [
  { label: "the card's serial: the path ends at a leaf of another key", crl: "g3-leaf", serial: cardSerial, expect: "old_leaf" },
  { label: "the card's serial: the path ends in an empty subtree", crl: "g2-empty", serial: cardSerial, expect: "empty" },
  { label: "a revoked serial: in the tree, no path", crl: "g3-leaf", serial: random[17]!, expect: "in_tree" },
  { label: "a serial of 20 bytes, not in the tree", crl: "g3-leaf", serial: (0x7fn << 152n) | 0x0123456789abcdef0123456789abcdefn, expect: "old_leaf" },
  { label: "an empty CRL: root 0, every sibling 0", crl: "g3-empty-list", serial: cardSerial, expect: "empty" },
];

const treeVectors = [];
const paths = new Map<string, AbsenceProof>();
for (const c of treeCases) {
  const r = await pathOrInTree(c.crl, c.serial);
  if (c.expect === "in_tree") {
    assert.equal(r.inTree, true, c.label);
    treeVectors.push({ label: c.label, crl: c.crl, serial: "0x" + c.serial.toString(16), in_tree: true });
    continue;
  }
  assert.equal(r.inTree, false, c.label);
  if (r.inTree) continue;
  assert.equal(r.proof.isOld0, c.expect === "empty", c.label);
  paths.set(`${c.crl} ${c.serial}`, r.proof);
  treeVectors.push({ label: c.label, crl: c.crl, serial: "0x" + c.serial.toString(16), in_tree: false, path: pathOf(r.proof) });
}

const revocationTree = {
  spec: "revocation-tree",
  status: "draft",
  note:
    "Paths built from whole CRLs. `crls`: CRLs in MOICA's layout (DER, hex), signed by `issuers` (test keys, not MOICA's; exponent 65537), each usable, with its root. " +
    "`cases`: a serial number (the key, hex) against one of them; `path` is the proof of absence in the form of the circuit's inputs, as `iamreal-crl prove` prints it. " +
    "Field elements are 0x-prefixed, 64 hex digits, big-endian. Small trees are in poseidon2.json (revocation_tree).",
  issuers,
  generated_by: GENERATED_BY,
  crls: crlSpecs.map((s) => {
    const c = crls.get(s.name)!;
    return { name: s.name, what: s.what, issuer: s.issuer, crl: hexOf(c.der), root: field(c.root) };
  }),
  cases: treeVectors,
};

// ------------------------------------------------------ the circuit inputs

const scopeString = scopeOf("test");
const scope = asciiBytes(scopeString);
const code = await declarationCode(scopeString, [{ platform: "threads", username: "alice" }], challenge);

async function circuitCase(label: string, world: World, crlName: string) {
  const checked = await checkCertificate(world.signingCert, day, world.issuers);
  assert.equal(checked.ok, true);
  if (!checked.ok) throw new Error(`${label}: the certificate does not pass`);
  const cert = checked.cert;
  const tree = paths.get(`${crlName} ${cert.serial}`)!;
  assert.ok(tree, `no path for ${label}`);
  const scopeSignature = await signWith(world.card, scope);
  const declarationCodeSignature = await signWith(world.card, code);
  const ct = currentTime(day);
  const inputs = circuitInputs({ cert, tree, currentTime: ct, scope, scopeSignature, declarationCode: code, declarationCodeSignature });
  const id = await scopedId(scopeSignature, hash2);
  const expected = expectedPublicInputs(cert, tree.root, ct, id, scope, code);
  const circuit = circuitOf(cert);

  // The circuit accepts the map, and computes the same public outputs.
  const compiled = JSON.parse(readFileSync(new URL(`../../circuits/${circuit}.json`, import.meta.url), "utf8"));
  const { returnValue } = await new Noir(compiled).execute(inputs as Parameters<Noir["execute"]>[0]);
  const out = returnValue as { nullifier: string; scope_packed: string; declaration_code_packed: string };
  assert.deepEqual([out.nullifier, out.scope_packed, out.declaration_code_packed].map((x) => BigInt(x)), expected.slice(-3));

  const spelled: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (k === "tbs" || k === "scope" || k === "declaration_code") spelled[k] = hexOf(Uint8Array.from(v as number[]));
    else if (Array.isArray(v)) spelled[k] = v.map((x) => field(BigInt(x as string)));
    else if (typeof v === "string") spelled[k] = field(BigInt(v));
    else spelled[k] = v;
  }
  return {
    label,
    issuer: cert.issuer.name,
    circuit,
    certificate: hexOf(world.signingCert),
    crl: crlName,
    path: pathOf(tree),
    current_time: Number(ct),
    scope_string: scopeString,
    scope_signature: hexOf(scopeSignature),
    declaration_code: new TextDecoder().decode(code),
    declaration_code_signature: hexOf(declarationCodeSignature),
    inputs: spelled,
    public_inputs: expected.map(field),
  };
}

const circuitVectors = {
  spec: "circuit-inputs",
  status: "draft",
  note:
    "Each case: a certificate (DER, hex) issued by one of `issuers` (test keys, not MOICA's; exponent 65537), the path of its serial number in the CRL `crl` of revocation-tree.json, `current_time` (a JSON number, spec/challenge.md), and the card's signatures (hex) over the scope string and the declaration code; " +
    "`inputs` is the circuit's input map and `public_inputs` the public inputs the proof must carry, in order. " +
    "In `inputs`, `tbs`, `scope` and `declaration_code` are byte arrays written as hex, `tbs_len` is a JSON number, `smt_is_old0` a boolean, and every other value (a field element or a list of limbs) is 0x-prefixed, 64 hex digits, big-endian. " +
    "The circuits in web/circuits/ accept every case.",
  issuers,
  generated_by: GENERATED_BY,
  cases: [
    await circuitCase("G3 certificate (card_proof_rs4096); the path ends at a leaf of another key", g3, "g3-leaf"),
    await circuitCase("G2 certificate (card_proof_rs2048); the path ends in an empty subtree", g2, "g2-empty"),
  ],
};

writeFileSync(repo("spec/vectors/revocation-tree.json"), JSON.stringify(revocationTree, null, 2) + "\n");
writeFileSync(repo("spec/vectors/circuit-inputs.json"), JSON.stringify(circuitVectors, null, 2) + "\n");
console.log("wrote spec/vectors/revocation-tree.json and spec/vectors/circuit-inputs.json");
