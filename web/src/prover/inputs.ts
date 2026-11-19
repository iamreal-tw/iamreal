// The circuit's inputs (zkid-noir tests/lib/inputs.mjs, noirCardProofInputs)
// and the public inputs the device expects the proof to carry
// (spec/proof-verification.md, "Public inputs").
import { bigintOfBytes, limbs } from "iamreal-protocol/bytes.ts";
import type { CardCertificate } from "../certificate.ts";
import { MAX_TBS_LEN } from "../certificate.ts";
import type { AbsenceProof } from "../crl/tree.ts";
import { CIRCUIT_OF_BITS, type CircuitName } from "../issuers.ts";
import { pack31 } from "iamreal-protocol/field.ts";

const hex = (x: bigint): string => "0x" + x.toString(16);

/** Barrett reduction parameter the bignum library takes next to a modulus. */
const redc = (modulus: bigint, bits: number): bigint => (1n << BigInt(2 * bits + 6)) / modulus;

export interface ProofInputs {
  cert: CardCertificate;
  tree: AbsenceProof;
  currentTime: bigint;
  scope: Uint8Array;
  scopeSignature: Uint8Array;
  declarationCode: Uint8Array;
  declarationCodeSignature: Uint8Array;
}

export function circuitOf(cert: CardCertificate): CircuitName {
  return CIRCUIT_OF_BITS[cert.issuer.bits].circuit;
}

/** The input map for noir_js. Every value is derived here; nothing comes from a server. */
export function circuitInputs(p: ProofInputs): Record<string, unknown> {
  const { cert, tree } = p;
  const k = CIRCUIT_OF_BITS[cert.issuer.bits].limbs;
  if (cert.tbs.length > MAX_TBS_LEN) throw new Error("TBS too long");
  const tbs = new Uint8Array(MAX_TBS_LEN);
  tbs.set(cert.tbs);
  if (p.scope.length !== 31 || p.declarationCode.length !== 31) throw new Error("signed messages are 31 bytes");
  const tbsArray = Array.from(tbs);
  tbs.fill(0);
  return {
    tbs: tbsArray,
    tbs_len: cert.tbs.length,
    issuer_modulus: limbs(cert.issuer.modulus, 120, k).map(hex),
    issuer_redc: limbs(redc(cert.issuer.modulus, cert.issuer.bits), 120, k).map(hex),
    issuer_signature: limbs(bigintOfBytes(cert.issuerSignature), 120, k).map(hex),
    smt_root: hex(tree.root),
    smt_siblings: tree.siblings.map(hex),
    smt_old_key: hex(tree.oldKey),
    smt_old_value: hex(tree.oldValue),
    smt_is_old0: tree.isOld0,
    current_time: hex(p.currentTime),
    card_redc: limbs(redc(cert.cardModulus, 2048), 120, 18).map(hex),
    scope: Array.from(p.scope),
    scope_signature: limbs(bigintOfBytes(p.scopeSignature), 120, 18).map(hex),
    declaration_code: Array.from(p.declarationCode),
    declaration_code_signature: limbs(bigintOfBytes(p.declarationCodeSignature), 120, 18).map(hex),
  };
}

/**
 * Once the proof is made (or not): the arrays of the input map are
 * overwritten, numbers with 0 and strings with "0x0", so that the map no
 * longer holds the certificate's bytes or the signatures' limbs. The strings
 * themselves cannot be zeroed in JavaScript; they are only no longer
 * referenced from here. What the proof engine copied is not reached
 * (README, "已知的限制").
 */
export function wipeInputs(inputs: Record<string, unknown>): void {
  for (const v of Object.values(inputs)) {
    if (!Array.isArray(v)) continue;
    for (let i = 0; i < v.length; i++) v[i] = typeof v[i] === "number" ? 0 : "0x0";
  }
}

/**
 * The public inputs, in the circuit's order, rebuilt by the device from what
 * it holds: issuer_modulus limbs, smt_root, current_time, nullifier (the
 * scoped ID), scope_packed, declaration_code_packed.
 */
export function expectedPublicInputs(cert: CardCertificate, smtRoot: bigint, currentTime: bigint, scopedId: bigint, scope: Uint8Array, declarationCode: Uint8Array): bigint[] {
  const k = CIRCUIT_OF_BITS[cert.issuer.bits].limbs;
  return [...limbs(cert.issuer.modulus, 120, k), smtRoot, currentTime, scopedId, pack31(scope), pack31(declarationCode)];
}
