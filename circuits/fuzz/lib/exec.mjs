// Turns a generated case into the inputs of each circuit, runs them, and
// compares every verdict and output with the reference and with each other.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bigToBytes, chunked, CIRCOM_BUILD, limbs, loadPoseidonP256, NOIR_ROOT, rngFor, signStd } from "./common.mjs";
import { genChain, genMessage, manualSpki, nonCanonical } from "./gen.mjs";
import { is2048, isCodeKind, isScopeKind, MAX_SIGNED_LEN, MAX_TBS_LEN, rsaVerify, walk } from "./oracle.mjs";
import { buildProof, DEPTH, smtExpect } from "./smt.mjs";

const require = createRequire(join(NOIR_ROOT, "package.json"));
const { Noir } = await import(pathToFileURL(require.resolve("@noir-lang/noir_js")).href);
const { BarretenbergSync } = await import(pathToFileURL(require.resolve("@aztec-foundation/bb.js")).href);

export const BN254 = 21888242871839275222246405745257275088548364400416711303968929903677763358721n;

// ---------------------------------------------------------------- runners
export class Runners {
  constructor({ noirTarget = join(NOIR_ROOT, "target"), circom = true } = {}) {
    this.noirTarget = noirTarget;
    this.noir = new Map();
    this.circom = new Map();
    this.useCircom = circom;
  }
  async init() {
    const bb = await BarretenbergSync.initSingleton();
    const toB = (x) => Buffer.from(x.toString(16).padStart(64, "0"), "hex");
    const h = (xs) => BigInt("0x" + Buffer.from(bb.poseidon2Hash({ inputs: xs.map(toB) }).hash).toString("hex"));
    this.p2 = { hash2: (a, b) => h([a, b]), hash3: (a, b, c) => h([a, b, c]), prime: BN254 };
    if (this.useCircom) {
      const c = await this.circomCalc("userSigRS2048");
      this.p256 = loadPoseidonP256(c.prime);
    }
  }
  async runNoir(name, inputs) {
    if (!this.noir.has(name)) this.noir.set(name, new Noir(JSON.parse(readFileSync(join(this.noirTarget, `${name}.json`), "utf8"))));
    try {
      const { returnValue, witness } = await this.noir.get(name).execute(inputs);
      return { verdict: "accept", returnValue, witness };
    } catch (e) {
      const msg = String(e.message ?? e).split("\n")[0];
      // ABI encoding errors mean the value cannot be given at all: also a reject.
      return { verdict: "reject", error: msg, abi: !/Circuit execution failed|Failed constraint|assert|Cannot satisfy/i.test(msg) };
    }
  }
  async circomCalc(name) {
    if (!this.circom.has(name)) {
      const dir = join(CIRCOM_BUILD, name, `${name}_js`);
      const builder = require(join(dir, "witness_calculator.js"));
      this.circom.set(name, await builder(readFileSync(join(dir, `${name}.wasm`))));
    }
    return this.circom.get(name);
  }
  async runCircom(name, inputs) {
    const calc = await this.circomCalc(name);
    try {
      const witness = await calc.calculateWitness(inputs, true);
      return { verdict: "accept", witness };
    } catch (e) {
      const msg = String(e.message ?? e).split("\n")[0];
      return { verdict: "reject", error: msg, harness: !/Assert Failed/.test(msg) };
    }
  }
}

// ---------------------------------------------------------------- helpers
const hex = (x) => "0x" + x.toString(16);
const pack31 = (m) => m.subarray(0, 31).reduce((acc, b, i) => acc + (BigInt(b) << BigInt(8 * i)), 0n);
const redc = (n, bits) => (1n << BigInt(2 * bits + 6)) / n;
const fits = (x, bits) => x >= 0n && x < 1n << BigInt(bits);

function sigLimbs(sig, bits, count, mut, circomSide) {
  let L = limbs(sig, bits, count);
  const top = sig >> BigInt(bits * count);
  if (top > 0n) L[count - 1] += top << BigInt(bits); // keep the integer, overflow the top limb
  if (mut) {
    const i = circomSide ? Math.min(mut.i, count - 2) : Math.min(mut.i, count - 2);
    L = nonCanonical(L, bits, i, mut.m) ?? nonCanonical(L, bits, (i + 1) % (count - 1), mut.m) ?? L;
  }
  return L;
}

/** Serial as the honest prover reads it (both circuits use the same bytes). */
function serialOf(tbs) {
  const sl = tbs[10];
  if (tbs[9] !== 0x02 || !(sl >= 1 && sl <= 20) || tbs.length < 11 + sl) return 0n;
  return BigInt("0x" + tbs.subarray(11, 11 + sl).toString("hex"));
}

/** Revocation list for a case: random serials, neighbours of the case's serial, maybe the serial. */
function revokedList(c, serial) {
  const r = rngFor(c.seed, c.index, "smt");
  const plan = c.smtPlan;
  const out = [];
  const n = plan.kind === "neighbours" ? r.int(2, 8) : r.int(0, 6);
  for (let i = 0; i < n; i++) {
    if (plan.kind === "neighbours" || r.bool(0.3)) {
      const k = r.weighted([[3, () => r.int(1, 20)], [2, () => r.int(100, 127)], [1, () => 128]])();
      const lowMask = (1n << BigInt(k)) - 1n;
      let v = (serial & lowMask) | (r.big(160) & ~lowMask);
      if (k < 160) v ^= 1n << BigInt(k);
      out.push(v & ((1n << 160n) - 1n));
    } else out.push(r.big(r.int(8, 160)));
  }
  if (plan.listedSerial) out.splice(r.int(0, out.length), 0, serial);
  // circomlib's tree cannot hold two keys equal in their low 128 bits.
  const low = new Set();
  const lst = [];
  if (plan.listedSerial) low.add(serial & ((1n << 128n) - 1n));
  for (const v of out) {
    if (v === serial && plan.listedSerial) { lst.push(v); continue; }
    const l = v & ((1n << 128n) - 1n);
    if (v === 0n || low.has(l) || v === serial) continue;
    low.add(l);
    lst.push(v);
  }
  return lst;
}

function noirSmt(p) {
  return { smt_root: hex(p.root), smt_siblings: p.siblings.map(hex), smt_old_key: hex(p.oldKey), smt_old_value: hex(p.oldValue), smt_is_old0: p.isOld0 };
}
function circomSmt(p) {
  return { smtRoot: String(p.root), smtSiblings: p.siblings.map(String), smtOldKey: String(p.oldKey), smtOldValue: String(p.oldValue), smtIsOld0: p.isOld0 ? "1" : "0" };
}

function sha256Pad(message, maxLength) {
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const out = Buffer.alloc(maxLength);
  message.copy(out);
  out[message.length] = 0x80;
  out.writeBigUInt64BE(BigInt(message.length) * 8n, paddedLength - 8);
  return [out, paddedLength];
}

// ---------------------------------------------------------------- chain
/**
 * Everything a certificate case needs on both sides: circuit inputs, and the
 * reference verdict. `tbsBytes` is the 1536-byte array the Noir circuits get,
 * `tbsLen` the length they are told; `signed` is what that length covers.
 */
export function prepareChain(rn, c, pool, { tbsBytes, tbsLen, issuerRedcOverride } = {}) {
  const K = c.bits === 2048 ? 18 : 35;
  const K121 = c.bits === 2048 ? 17 : 34;
  const signed = tbsBytes ? Buffer.from(tbsBytes.subarray(0, tbsLen)) : c.tbs;
  const serial = serialOf(signed);
  c.smtPlan.revoked = revokedList(c, serial);
  const proofN = buildProof(rn.p2, serial, c.smtPlan);
  const proofC = rn.useCircom ? buildProof(rn.p256, serial, c.smtPlan) : null;
  const honest = buildProof(rn.p2, serial, { ...c.smtPlan, mut: "none", revoked: c.smtPlan.revoked.filter((k) => k !== serial) });
  const smtOk = smtExpect(serial, c.smtPlan, honest);

  const ref = walk(signed, c.now);
  const sigCanon = !c.sigLimbsMut;
  const sigOk = rsaVerify(c.issuerModulus, c.signature, signed);
  const certOk = ref.ok && sigOk && smtOk && sigCanon;
  const reason = !ref.ok ? `walk: ${ref.reason}` : !sigOk ? "issuer signature" : !sigCanon ? "non-canonical signature limbs" : !smtOk ? "revocation" : "ok";

  let noir = null;
  if (signed.length <= MAX_TBS_LEN || tbsBytes) {
    let arr = tbsBytes;
    if (!arr) {
      arr = Buffer.alloc(MAX_TBS_LEN);
      if (c.tbs.length <= MAX_TBS_LEN) c.tbs.copy(arr);
      if (c.garbage) {
        const g = rngFor(c.seed, c.index, "garbage").bytes(MAX_TBS_LEN);
        g.copy(arr, c.tbs.length, c.tbs.length);
      }
    }
    const sigL = sigLimbs(c.signature, 120, K, c.sigLimbsMut, false);
    noir = {
      tbs: Array.from(arr),
      tbs_len: tbsLen ?? c.tbs.length,
      issuer_modulus: limbs(c.issuerModulus, 120, K).map(hex),
      issuer_redc: (issuerRedcOverride ?? limbs(redc(c.issuerModulus, c.bits), 120, K)).map(hex),
      issuer_signature: sigL.map(hex),
      ...noirSmt(proofN),
      current_time: hex(c.now),
    };
    if (sigL.some((l) => l >= 1n << 128n)) noir.abiOverflow = true;
  }
  let circom = null;
  if (rn.useCircom && signed.length + 9 <= MAX_TBS_LEN && !tbsBytes) {
    const [padded, paddedLength] = sha256Pad(signed, MAX_TBS_LEN);
    circom = {
      issuerTbs: Array.from(padded).map(String),
      issuerTbsLength: String(paddedLength),
      actualIssuerTbsLength: String(signed.length),
      issuerRsaModulus: limbs(c.issuerModulus, 121, K121).map(String),
      issuerRsaSignature: sigLimbs(c.signature, 121, K121, c.sigLimbsMut, true).map(String),
      serialNumber: String(serial),
      ...circomSmt(proofC),
      currentTime: String(c.now),
      pkBlind: String(c.pkBlind),
    };
  }
  return { noir, circom, ref, certOk, reason, serial, signed, smtOk };
}

/** The card's two messages and signatures for a certificate case. */
function cardParts(c, pool, ref, r) {
  const keyUsable = c.subjectKey && ["user2048", "user2047"].includes(c.subjectKey.group);
  const key = keyUsable ? pool[c.subjectKey.group][c.subjectKey.idx] : pool.user2048[0];
  const scope = genMessage(r, "scope");
  const code = genMessage(r, "code");
  const readModulus = ref.ok ? BigInt("0x" + ref.modulus.toString("hex")) : key.modulus;
  return { key, scope, code, scopeSig: signStd(key, scope), codeSig: signStd(key, code), readModulus };
}

function cardInputs(chainNoir, parts, over = {}) {
  const m = parts.readModulus;
  return {
    ...chainNoir,
    card_redc: (over.cardRedc ?? limbs(redc(m, 2048), 120, 18)).map(hex),
    scope: Array.from(over.scope ?? parts.scope),
    scope_signature: (over.scopeSigLimbs ?? sigLimbs(over.scopeSig ?? parts.scopeSig, 120, 18)).map(hex),
    declaration_code: Array.from(over.code ?? parts.code),
    declaration_code_signature: sigLimbs(over.codeSig ?? parts.codeSig, 120, 18).map(hex),
  };
}

function cardExpect(certOk, m, scope, scopeSig, code, codeSig, canon = true) {
  const checks = [
    [certOk, "certificate"], [is2048(m), "card key not 2048 bits"], [isScopeKind(scope[0]), "scope kind"],
    [rsaVerify(m, scopeSig, scope), "scope signature"], [isCodeKind(code[0]), "code kind"],
    [rsaVerify(m, codeSig, code), "code signature"], [canon, "non-canonical scope limbs"],
  ];
  const bad = checks.find(([ok]) => !ok);
  return { ok: !bad, reason: bad ? bad[1] : "ok" };
}

const stripNoir = (o) => { if (!o) return o; const { abiOverflow, ...rest } = o; return rest; };

// ---------------------------------------------------------------- run one case
/**
 * Runs `c` and returns { rows, findings }. A row per circuit: name, expected,
 * verdict, error. A finding is any verdict that differs from what is expected
 * (or between Noir and circom), or any output that differs from the value
 * computed outside the circuits.
 */
export async function runCase(rn, c, pool) {
  const rows = [];
  const issues = [];
  const inputs = {};
  const add = (circuit, expected, res, why) => {
    rows.push({ circuit, expected, verdict: res?.verdict ?? "n/a", error: res?.error, why });
    if (res && expected !== "any" && res.verdict !== expected) issues.push(`${circuit}: expected ${expected} (${why}), got ${res.verdict}${res.error ? ` [${res.error}]` : ""}`);
    if (res?.harness) issues.push(`${circuit}: harness error ${res.error}`);
  };

  if (c.family === "chain") {
    const p = prepareChain(rn, c, pool);
    const exp = p.certOk ? "accept" : "reject";
    const part = c.bits === 2048 ? "cert_chain_rs2048" : "cert_chain_rs4096";
    let resPart = null, resCard = null, resCircom = null;
    if (p.noir) {
      inputs[part] = { ...stripNoir(p.noir), pk_blind: hex(c.pkBlind) };
      resPart = await rn.runNoir(part, inputs[part]);
      add(part, exp, resPart, p.reason);
      if (resPart.verdict === "accept" && p.ref.ok) {
        const want = chunked(rn.p2, [...limbs(BigInt("0x" + p.ref.modulus.toString("hex")), 120, 18), c.pkBlind]);
        if (BigInt(resPart.returnValue) !== want) issues.push(`${part}: pk_commit is not the commitment to the structural key`);
      }
      const parts = cardParts(c, pool, p.ref, rngFor(c.seed, c.index, "card"));
      const card = c.bits === 2048 ? "card_proof_rs2048" : "card_proof_rs4096";
      inputs[card] = cardInputs(stripNoir(p.noir), parts);
      const ce = cardExpect(p.certOk, parts.readModulus, parts.scope, parts.scopeSig, parts.code, parts.codeSig);
      resCard = await rn.runNoir(card, inputs[card]);
      add(card, ce.ok ? "accept" : "reject", resCard, ce.reason);
      if (resCard.verdict === "accept") checkCardOutputs(rn, resCard, parts.scope, parts.scopeSig, parts.code, issues, card);
    }
    if (p.circom) {
      const name = c.bits === 2048 ? "certChainRS2048" : "certChainRS4096";
      inputs[name] = p.circom;
      resCircom = await rn.runCircom(name, p.circom);
      add(name, exp, resCircom, p.reason);
      if (resCircom.verdict === "accept" && p.ref.ok) {
        const want = chunked(rn.p256, [...limbs(BigInt("0x" + p.ref.modulus.toString("hex")), 121, 17), c.pkBlind]);
        if (resCircom.witness[1] !== want) issues.push(`${name}: pkCommit is not the commitment to the structural key`);
      }
    } else if (rn.useCircom) {
      rows.push({ circuit: "circom", expected: exp, verdict: "n/a", why: "TBS does not fit the circom buffer" });
      if (exp === "accept") issues.push("circom: an acceptable TBS that circom cannot take");
    }
    if (resPart && resCircom && resPart.verdict !== resCircom.verdict) issues.push(`Noir part and circom disagree: ${resPart.verdict} vs ${resCircom.verdict}`);
    return { rows, issues, inputs, ref: { reason: p.reason, serial: String(p.serial) } };
  }

  if (c.family === "sig") {
    const canon = !c.sigLimbsMut;
    const valid = rsaVerify(c.modulus, c.signature, c.message) && canon;
    const kindOk = c.position === "scope" ? isScopeKind(c.message[0]) : isCodeKind(c.message[0]);
    const why = !canon ? "non-canonical limbs" : !valid ? "signature" : !is2048(c.modulus) ? "key not 2048 bits" : !kindOk ? "kind" : "ok";
    const noirExp = c.message.length === 31 && valid && is2048(c.modulus) && kindOk;
    const circomExp = c.message.length === 31 && valid;
    const part = c.position === "scope" ? "user_sig_scope" : "user_sig_code";
    let resPart = null, resCircom = null, keyChain = null;
    if (c.message.length === 31 && fits(c.modulus, 2160)) {
      const L = sigLimbs(c.signature, 120, 18, c.sigLimbsMut, false);
      inputs[part] = {
        [c.position === "scope" ? "scope" : "declaration_code"]: Array.from(c.message),
        user_modulus: limbs(c.modulus, 120, 18).map(hex),
        user_redc: limbs(redc(c.modulus, 2048), 120, 18).map(hex),
        user_signature: L.map(hex),
        pk_blind: hex(c.pkBlind),
      };
      resPart = await rn.runNoir(part, inputs[part]);
      add(part, noirExp ? "accept" : "reject", resPart, why);
      if (resPart.verdict === "accept") {
        const rv = resPart.returnValue;
        if (BigInt(rv.pk_commit) !== chunked(rn.p2, [...limbs(c.modulus, 120, 18), c.pkBlind])) issues.push(`${part}: pk_commit`);
        if (c.position === "scope") {
          if (BigInt(rv.nullifier) !== chunked(rn.p2, limbs(c.signature, 120, 18))) issues.push(`${part}: nullifier is not the hash of the canonical signature`);
          if (BigInt(rv.scope_packed) !== pack31(c.message)) issues.push(`${part}: scope_packed`);
        } else if (BigInt(rv.declaration_code_packed) !== pack31(c.message)) issues.push(`${part}: declaration_code_packed`);
      }

      // The same signature inside a whole card proof, the rest honest.
      if (fits(c.modulus, 2048)) {
        const r = rngFor(c.seed, c.index, "chain");
        const spki = manualSpki(bigToBytes(c.modulus, 256));
        const chain = genChain(r, pool, "none", { spki, subjectKey: c.keyRef });
        const pc = prepareChain(rn, chain, pool);
        keyChain = { chain, pc };
        const key = pool[c.keyRef.group][c.keyRef.idx];
        const other = genMessage(rngFor(c.seed, c.index, "other"), c.position === "scope" ? "code" : "scope");
        const otherSig = signStd(key, other);
        const parts = { readModulus: c.modulus };
        const over = c.position === "scope"
          ? { scope: c.message, scopeSigLimbs: L, code: other, codeSig: otherSig }
          : { scope: other, scopeSig: otherSig, code: c.message, codeSig: c.signature };
        const card = chain.bits === 2048 ? "card_proof_rs2048" : "card_proof_rs4096";
        if (pc.noir) {
          const ci = cardInputs(stripNoir(pc.noir), parts, over);
          if (c.position === "code") ci.declaration_code_signature = L.map(hex);
          inputs[card] = ci;
          const sc = c.position === "scope" ? [c.message, c.signature, other, otherSig] : [other, otherSig, c.message, c.signature];
          const ce = cardExpect(pc.certOk, c.modulus, sc[0], sc[1], sc[2], sc[3], canon);
          const res = await rn.runNoir(card, ci);
          add(card, ce.ok ? "accept" : "reject", res, `${ce.reason}; cert: ${pc.reason}`);
          if (res.verdict === "accept") checkCardOutputs(rn, res, sc[0], sc[1], sc[2], issues, card);
        }
      }
    }
    if (rn.useCircom && c.message.length + 9 <= MAX_TBS_LEN && fits(c.modulus, 17 * 121)) {
      const [padded] = sha256Pad(c.message, MAX_TBS_LEN);
      inputs.userSigRS2048 = {
        tbs: Array.from(padded).map(String),
        userPkLimbs: limbs(c.modulus, 121, 17).map(String),
        userRsaSignature: sigLimbs(c.signature, 121, 17, c.sigLimbsMut, true).map(String),
        pkBlind: String(c.pkBlind),
        challenge: String(c.challenge),
      };
      resCircom = await rn.runCircom("userSigRS2048", inputs.userSigRS2048);
      add("userSigRS2048", circomExp ? "accept" : "reject", resCircom, why);
      if (resCircom.verdict === "accept") {
        const w = resCircom.witness;
        if (w[1] !== chunked(rn.p256, [...limbs(c.modulus, 121, 17), c.pkBlind])) issues.push("userSigRS2048: pkCommit");
        if (w[2] !== chunked(rn.p256, limbs(c.signature, 121, 17))) issues.push("userSigRS2048: nullifier is not the hash of the canonical signature");
        if (w[3] !== pack31(c.message)) issues.push("userSigRS2048: appIdPacked");
      }
    }
    if (resPart && resCircom && resPart.verdict !== resCircom.verdict) {
      const intended = valid && is2048(c.modulus) && !kindOk; // ADR-0013 kind check, circom has none
      // A valid signature by a key that is not 2048 bits long: the Noir
      // signature part rejects it by itself; circom's signature circuit does
      // not look at the key length and leaves that to its certificate circuit
      // (the key commitment ties the two). So here circom's certificate
      // circuit must reject an otherwise valid certificate carrying this key.
      const keyLength = valid && !is2048(c.modulus) && resPart.verdict === "reject" && resCircom.verdict === "accept";
      // The certificate made for the card proof above may be too long for
      // circom's buffer (or the modulus too wide for the card proof): make
      // another one for this check.
      for (let j = 0; keyLength && !keyChain?.pc.circom && j < 20 && fits(c.modulus, 2048); j++) {
        const chain = genChain(rngFor(c.seed, c.index, "key-length", j), pool, "none",
          { spki: manualSpki(bigToBytes(c.modulus, 256)), subjectKey: c.keyRef });
        keyChain = { chain, pc: prepareChain(rn, chain, pool) };
      }
      if (intended) rows.push({ circuit: "note", verdict: "intended difference: kind check" });
      else if (keyLength && keyChain?.pc.circom) {
        const name = keyChain.chain.bits === 2048 ? "certChainRS2048" : "certChainRS4096";
        inputs[name] = keyChain.pc.circom;
        const resCert = await rn.runCircom(name, keyChain.pc.circom);
        add(name, "reject", resCert, `certificate carrying this key; ${keyChain.pc.reason}`);
        if (resCert.verdict === "reject") rows.push({ circuit: "note", verdict: "part-level difference: circom checks the key length in its certificate circuit" });
        else issues.push("circom accepts a card key that is not 2048 bits long in both its signature and its certificate circuit");
      } else issues.push(`Noir part and circom disagree: ${resPart.verdict} vs ${resCircom.verdict}`);
    }
    return { rows, issues, inputs, ref: { reason: why } };
  }

  // ---- card: whole card proofs, Noir only
  const ch = c.chain;
  const r = rngFor(c.seed, c.index, "cardmut");
  let tbsBytes = null, tbsLen = null, issuerRedcOverride = null;
  if (c.mutation === "tbs-len-short" || c.mutation === "tbs-len-long" || c.mutation === "garbage-after-len") {
    tbsBytes = Buffer.alloc(MAX_TBS_LEN);
    if (ch.tbs.length <= MAX_TBS_LEN) ch.tbs.copy(tbsBytes);
    const g = r.bytes(MAX_TBS_LEN);
    g.copy(tbsBytes, Math.min(ch.tbs.length, MAX_TBS_LEN), Math.min(ch.tbs.length, MAX_TBS_LEN));
    tbsLen = Math.min(ch.tbs.length, MAX_TBS_LEN);
    if (c.mutation === "tbs-len-short") tbsLen = Math.max(0, tbsLen - r.int(1, 200));
    if (c.mutation === "tbs-len-long") tbsLen = Math.min(MAX_TBS_LEN, tbsLen + r.int(1, 20));
  }
  if (c.mutation === "truncate-keep-tail" && ch.tbs.length <= MAX_TBS_LEN) {
    // A prover who truncates the signed TBS but leaves the original bytes after
    // tbs_len in the array: the CA signs the truncated, length-fixed prefix.
    const w0 = walk(ch.tbs, ch.now);
    const end = w0.at.end ?? ch.tbs.length;
    const cut = r.bool(0.7) ? r.int(Math.max(4, end - 8), end - 1) : r.int(4, ch.tbs.length - 1);
    const signed = Buffer.from(ch.tbs.subarray(0, cut));
    signed.writeUInt16BE(cut - 4, 2);
    tbsBytes = Buffer.alloc(MAX_TBS_LEN);
    ch.tbs.copy(tbsBytes);
    signed.copy(tbsBytes);
    tbsLen = cut;
    ch.signature = signStd(pool[ch.caRef.group][ch.caRef.idx], signed);
  }
  if (c.mutation === "issuer-redc") issuerRedcOverride = limbs(r.big(ch.bits + 6), 120, ch.bits === 2048 ? 18 : 35);
  const p = prepareChain(rn, ch, pool, { tbsBytes, tbsLen, issuerRedcOverride });
  if (!p.noir) return { rows, issues, inputs, ref: { reason: "not expressible" } };
  const parts = cardParts(ch, pool, p.ref, rngFor(c.seed, c.index, "card"));
  const key = parts.key;
  let { scope, code, scopeSig, codeSig } = parts;
  const over = {};
  let canon = true;
  switch (c.mutation) {
    case "swap-sigs": [scopeSig, codeSig] = [codeSig, scopeSig]; break;
    case "same-message": code = scope; codeSig = scopeSig; break;
    case "scope-noncanon": over.scopeSigLimbs = sigLimbs(scopeSig, 120, 18, { i: r.int(0, 16), m: 1n }); canon = false; break;
    case "other-key-sigs": { const k2 = pool.user2048[(pool.user2048.indexOf(key) + 1) % pool.user2048.length]; scopeSig = signStd(k2, scope); codeSig = signStd(k2, code); break; }
    case "card-redc": over.cardRedc = limbs(r.big(2054), 120, 18); break;
    case "scope-plus-n": scopeSig += parts.readModulus; break;
    case "code-other-challenge": code = genMessage(r, "code"); break;
    case "kind-swap": [scope, code, scopeSig, codeSig] = [code, scope, codeSig, scopeSig]; break;
    case "scope-uppercase": {
      scope = Buffer.from(scope);
      scope[0] = 0x41 + r.int(0, 25); // `S` (1 in 26) is a scope string: those must be accepted
      scopeSig = signStd(key, scope);
      break;
    }
  }
  Object.assign(over, { scope, code, scopeSig, codeSig });
  const card = ch.bits === 2048 ? "card_proof_rs2048" : "card_proof_rs4096";
  inputs[card] = cardInputs(stripNoir(p.noir), parts, over);
  const ce = cardExpect(p.certOk, parts.readModulus, scope, scopeSig, code, codeSig, canon);
  let expected = ce.ok ? "accept" : "reject";
  if (ce.ok && (c.mutation === "card-redc" || c.mutation === "issuer-redc")) expected = "any"; // completeness only
  const res = await rn.runNoir(card, inputs[card]);
  add(card, expected, res, `${ce.reason}; cert: ${p.reason}`);
  if (res.verdict === "accept") checkCardOutputs(rn, res, scope, scopeSig, code, issues, card);
  return { rows, issues, inputs, ref: { reason: ce.reason, cert: p.reason } };
}

function checkCardOutputs(rn, res, scope, scopeSig, code, issues, name) {
  const rv = res.returnValue;
  if (BigInt(rv.nullifier) !== chunked(rn.p2, limbs(scopeSig, 120, 18))) issues.push(`${name}: nullifier is not the hash of the canonical scope signature`);
  if (BigInt(rv.scope_packed) !== pack31(scope)) issues.push(`${name}: scope_packed`);
  if (BigInt(rv.declaration_code_packed) !== pack31(code)) issues.push(`${name}: declaration_code_packed`);
}
