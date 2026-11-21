// Turns one test case into the inputs of each circuit: the card proof circuit,
// the Noir comparison circuits, and the circom circuit.
import { serialOf, signWith } from "./cert.mjs";

export const MAX_TBS_LEN = 1536;
export const SMT_DEPTH = 128;

const hexOf = (x) => "0x" + x.toString(16);

/** `count` limbs of `bits` bits, least significant first. */
export function limbs(value, bits, count) {
  const mask = (1n << BigInt(bits)) - 1n;
  return Array.from({ length: count }, (_, i) => (value >> BigInt(bits * i)) & mask);
}

/**
 * `value` in another limb encoding: limb `i` gains 2^bits and limb `i + 1`
 * loses 1, so the integer is the same and the limbs are not. `i` is the first
 * limb where the modulus limb is larger than the value's. There the limb-wise
 * subtraction `modulus - value` (all that "value < modulus" checks) still
 * works out, so only a range check on each limb rejects the encoding.
 */
export function shiftedLimbs(value, modulus, bits, count) {
  const l = limbs(value, bits, count);
  const m = limbs(modulus, bits, count);
  for (let i = 0; i < count - 1; i++) {
    if (m[i] > l[i] && l[i + 1] > 0n) {
      l[i] += 1n << BigInt(bits);
      l[i + 1] -= 1n;
      return l;
    }
  }
  throw new Error("no limb to shift");
}

const signatureLimbs = (value, modulus, bits, count, shift) =>
  shift ? shiftedLimbs(value, modulus, bits, count) : limbs(value, bits, count);

const limbCount = (keyBits, limbBits) => Math.ceil(keyBits / limbBits);

/** Barrett reduction parameter `bignum` expects next to a modulus. */
const redc = (modulus, keyBits) => (1n << BigInt(2 * keyBits + 6)) / modulus;

/** SHA-256 padding, then zero-fill to `maxLength`. Returns [bytes, paddedLength]. */
export function sha256Pad(message, maxLength) {
  const bitLength = BigInt(message.length) * 8n;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const out = Buffer.alloc(maxLength);
  message.copy(out);
  out[message.length] = 0x80;
  out.writeBigUInt64BE(bitLength, paddedLength - 8);
  return [out, paddedLength];
}

const emptyTreeProof = { root: 0n, siblings: Array(SMT_DEPTH).fill(0n), oldKey: 0n, oldValue: 0n, isOld0: true };

/**
 * A certificate-proof case: `tbs` signed by `ca`, checked at `currentTime`.
 * `smt` is a non-membership proof (default: the empty tree). `signature`
 * overrides the CA signature (as an integer). `shiftLimb`: give the signature
 * in a non-canonical limb encoding (`shiftedLimbs`).
 */
export function chainCase({ ca, tbs, currentTime, smt = emptyTreeProof, pkBlind = 12345n, signature, shiftLimb = false }) {
  return { ca, tbs, currentTime, smt, pkBlind, signature: signature ?? signWith(ca, tbs), shiftLimb };
}

/** Certificate inputs shared by the card proof circuit and `cert_chain_*`. */
export function noirCertificateInputs(c) {
  const k = limbCount(c.ca.bits, 120);
  const tbs = Buffer.alloc(MAX_TBS_LEN);
  c.tbs.copy(tbs);
  return {
    tbs: Array.from(tbs),
    tbs_len: c.tbs.length,
    issuer_modulus: limbs(c.ca.modulus, 120, k).map(hexOf),
    issuer_redc: limbs(redc(c.ca.modulus, c.ca.bits), 120, k).map(hexOf),
    issuer_signature: signatureLimbs(c.signature, c.ca.modulus, 120, k, c.shiftLimb).map(hexOf),
    smt_root: hexOf(c.smt.root),
    smt_siblings: c.smt.siblings.map(hexOf),
    smt_old_key: hexOf(c.smt.oldKey),
    smt_old_value: hexOf(c.smt.oldValue),
    smt_is_old0: c.smt.isOld0,
    current_time: hexOf(c.currentTime),
  };
}

/** Inputs of the comparison circuits `comparison/cert_chain_*`. */
export function noirChainInputs(c) {
  return { ...noirCertificateInputs(c), pk_blind: hexOf(c.pkBlind) };
}

export function circomChainInputs(c) {
  // The padded TBS must fit the circuit's buffer; a longer one has no inputs.
  if (Math.ceil((c.tbs.length + 9) / 64) * 64 > MAX_TBS_LEN) return null;
  const k = limbCount(c.ca.bits, 121);
  const [padded, paddedLength] = sha256Pad(c.tbs, MAX_TBS_LEN);
  return {
    issuerTbs: Array.from(padded).map(String),
    issuerTbsLength: String(paddedLength),
    actualIssuerTbsLength: String(c.tbs.length),
    issuerRsaModulus: limbs(c.ca.modulus, 121, k).map(String),
    issuerRsaSignature: signatureLimbs(c.signature, c.ca.modulus, 121, k, c.shiftLimb).map(String),
    smtRoot: String(c.smt.root),
    serialNumber: String(c.serialNumber ?? serialOf(c.tbs)),
    smtSiblings: c.smt.siblings.map(String),
    smtOldKey: String(c.smt.oldKey),
    smtOldValue: String(c.smt.oldValue),
    smtIsOld0: c.smt.isOld0 ? "1" : "0",
    currentTime: String(c.currentTime),
    pkBlind: String(c.pkBlind),
  };
}

/**
 * A signature case: `key` signs `message`. The circuits only accept a 31-byte
 * message; longer ones are here to show circom rejects them. `challenge` goes
 * to circom only: the Noir circuits have no challenge input. `shiftLimb`: give
 * the signature in a non-canonical limb encoding (`shiftedLimbs`).
 */
export function sigCase({ key, message, pkBlind = 12345n, challenge = 42n, signature, shiftLimb = false }) {
  return { key, message, pkBlind, challenge, signature: signature ?? signWith(key, message), shiftLimb };
}

/**
 * Inputs of the comparison circuits `comparison/user_sig_*`. `messageName` is
 * the circuit's name for the signed bytes: `scope` or `declaration_code`.
 */
export function noirSigInputs(c, messageName = "scope") {
  if (c.message.length !== 31) return null; // not expressible: the input is 31 bytes
  return {
    [messageName]: Array.from(c.message),
    user_modulus: limbs(c.key.modulus, 120, 18).map(hexOf),
    user_redc: limbs(redc(c.key.modulus, 2048), 120, 18).map(hexOf),
    user_signature: signatureLimbs(c.signature, c.key.modulus, 120, 18, c.shiftLimb).map(hexOf),
    pk_blind: hexOf(c.pkBlind),
  };
}

export function circomSigInputs(c) {
  const [padded] = sha256Pad(c.message, MAX_TBS_LEN);
  return {
    tbs: Array.from(padded).map(String),
    userPkLimbs: limbs(c.key.modulus, 121, 17).map(String),
    userRsaSignature: signatureLimbs(c.signature, c.key.modulus, 121, 17, c.shiftLimb).map(String),
    pkBlind: String(c.pkBlind),
    challenge: String(c.challenge),
  };
}

/**
 * Inputs of the card proof circuit: the certificate case `chain` plus the card
 * key's signatures over `scope` and `code`. Overrides: `scopeSignature`,
 * `codeSignature` (integers); `shiftScope`, `shiftCode`: give that signature
 * in a non-canonical limb encoding (`shiftedLimbs`).
 */
export function noirCardProofInputs({ chain, key, scope, code, scopeSignature, codeSignature, shiftScope = false, shiftCode = false }) {
  return {
    ...noirCertificateInputs(chain),
    card_redc: limbs(redc(key.modulus, 2048), 120, 18).map(hexOf),
    scope: Array.from(scope),
    scope_signature: signatureLimbs(scopeSignature ?? signWith(key, scope), key.modulus, 120, 18, shiftScope).map(hexOf),
    declaration_code: Array.from(code),
    declaration_code_signature: signatureLimbs(codeSignature ?? signWith(key, code), key.modulus, 120, 18, shiftCode).map(hexOf),
  };
}
