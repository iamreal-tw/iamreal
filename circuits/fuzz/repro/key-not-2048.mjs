// Minimal reproducer: a card key whose modulus has its top bit clear (a
// 2047-bit key, or any shorter key written into the 256 bytes after the pinned
// `02 82 01 01 00`). Both certificate parts accept the certificate; circom's
// userSig accepts the key's signatures; the Noir card proof rejects, because
// BigNumParams::new requires the modulus to be exactly 2048 bits.
//
//   ZKID_CIRCOM_BUILD=... node repro/key-not-2048.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bigToBytes, FUZZ, loadPool, rngFor, signStd } from "../lib/common.mjs";
import { genChain, genMessage, manualSpki } from "../lib/gen.mjs";
import { Runners, prepareChain } from "../lib/exec.mjs";
import { walk } from "../lib/oracle.mjs";
import { CODE } from "../../tests/cases.mjs";

const pool = loadPool();
const rn = new Runners();
await rn.init();
const hex = (x) => "0x" + x.toString(16);
const limbs = (v, b, n) => Array.from({ length: n }, (_, i) => (v >> BigInt(b * i)) & ((1n << BigInt(b)) - 1n));
const redc = (n) => (1n << 4102n) / n;
const out = {};
for (const group of ["user2047", "user1024"]) {
  const key = pool[group][0];
  // A valid certificate (no mutation) for this key.
  let c, p;
  for (let i = 0; ; i++) {
    c = genChain(rngFor("repro-key", group, i), pool, "none", { spki: manualSpki(bigToBytes(key.modulus, 256)), subjectKey: { group, idx: 0 } });
    c.seed = "repro-key"; c.index = i;
    p = prepareChain(rn, c, pool);
    if (p.certOk) break;
  }
  const scope = Buffer.from("iamreal-test:threads:0_________");
  // The tests' declaration code: a standard answer of spec/vectors/declaration-code.json.
  const code = CODE;
  const ss = signStd(key, scope), cs = signStd(key, code);
  const certNoir = await rn.runNoir("cert_chain_rs2048", { ...p.noir, pk_blind: "0x3039" });
  const certCircom = await rn.runCircom("certChainRS2048", p.circom);
  const pad = (m) => { const b = Buffer.alloc(1536); m.copy(b); b[31] = 0x80; b[63] = 0xf8; return Array.from(b).map(String); };
  const sigCircom = await rn.runCircom("userSigRS2048", { tbs: pad(scope), userPkLimbs: limbs(key.modulus, 121, 17).map(String), userRsaSignature: limbs(ss, 121, 17).map(String), pkBlind: "12345", challenge: "1" });
  const codeCircom = await rn.runCircom("userSigRS2048", { tbs: pad(code), userPkLimbs: limbs(key.modulus, 121, 17).map(String), userRsaSignature: limbs(cs, 121, 17).map(String), pkBlind: "12345", challenge: "1" });
  const sigNoir = await rn.runNoir("user_sig_scope", { scope: Array.from(scope), user_modulus: limbs(key.modulus, 120, 18).map(hex), user_redc: limbs(redc(key.modulus), 120, 18).map(hex), user_signature: limbs(ss, 120, 18).map(hex), pk_blind: "0x3039" });
  const cardInputs = { ...p.noir, card_redc: limbs(redc(key.modulus), 120, 18).map(hex), scope: Array.from(scope), scope_signature: limbs(ss, 120, 18).map(hex), declaration_code: Array.from(code), declaration_code_signature: limbs(cs, 120, 18).map(hex) };
  const card = await rn.runNoir("card_proof_rs2048", cardInputs);
  const v = (r) => r.verdict + (r.error ? ` (${r.error})` : "");
  console.log(`${group} (modulus ${key.modulus.toString(2).length} bits, first modulus byte 0x${bigToBytes(key.modulus, 256)[0].toString(16)}):`);
  console.log(`  cert_chain_rs2048 ${v(certNoir)} | certChainRS2048 ${v(certCircom)}`);
  console.log(`  user_sig_scope ${v(sigNoir)} | userSigRS2048 scope ${v(sigCircom)}, code ${v(codeCircom)}`);
  console.log(`  card_proof_rs2048 ${v(card)}`);
  out[group] = { walk: walk(c.tbs, c.now).reason, card_proof_rs2048: cardInputs, certChainRS2048: p.circom };
}
mkdirSync(join(FUZZ, "findings"), { recursive: true });
writeFileSync(join(FUZZ, "findings", "min-key-not-2048.json"), JSON.stringify(out));
