// Makes the real proofs in this directory, one per circuit, with throwaway
// issuer and card keys. See README.md for how to run it.
//
//   node make-proofs.mjs <zkid-noir checkout> <bb> <crs dir> <out dir>
//
// It uses the test helpers of zkid-noir (tests/lib/) the way its
// bench/make-inputs.mjs does, and its compiled circuits (target/). Nothing is
// written into the zkid-noir checkout. The private keys are not kept.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [zkid, bb, crs, out] = process.argv.slice(2).map((p) => resolve(p));
if (!out) throw new Error("usage: node make-proofs.mjs <zkid-noir> <bb> <crs dir> <out dir>");
const lib = (f) => import(join(zkid, "tests", "lib", f));
const { buildTbs, makeKey, serialOf } = await lib("cert.mjs");
const { loadPoseidon2 } = await lib("hashes.mjs");
const { chainCase, noirCardProofInputs } = await lib("inputs.mjs");
const { runNoir } = await lib("run.mjs");
const { Smt } = await lib("smt.mjs");
const { declarationCode } = await lib("declaration-code.mjs");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const git = (...args) => execFileSync("git", ["-C", zkid, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain") !== "") throw new Error("zkid-noir has uncommitted changes");

// The verification keys of spec/record.md, "Accepted circuits".
const VK_SHA256 = {
  card_proof_rs2048: "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8",
  card_proof_rs4096: "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
};
const SCOPE = "iamreal-test:threads:0_________";
// One record per circuit; together a test roster in which both are valid.
// The challenges are those of spec/vectors/challenge.json.
const RECORDS = [
  { circuit: "card_proof_rs2048", issuer: "G2", bits: 2048, action: "declare", username: "alice",
    challenge: "2026-11-16.000G40R40M30E209185GR38E1W" },
  { circuit: "card_proof_rs4096", issuer: "G3", bits: 4096, action: "withdraw", username: "alice",
    challenge: "2027-01-01.BQC3JFKB1AYNR9ZE3YV4H4AYRR" },
];

// current_time: the last second of the challenge's date in Taiwan, in UTC.
const currentTime = (challenge) => BigInt(challenge.slice(2, 4) + challenge.slice(5, 7) + challenge.slice(8, 10) + "155959");

const card = makeKey(2048);
const tbs = buildTbs({ spki: card.spki, notBefore: "260101000000Z", notAfter: "310101155959Z" });
const poseidon2 = await loadPoseidon2();
const tree = new Smt(poseidon2.hash2, poseidon2.hash3);
for (let i = 0; i < 200; i++) tree.insert(BigInt("0x" + sha256(`revoked ${i}`).slice(0, 32)));
const smt = tree.proveAbsent(serialOf(tbs));

mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "make-proofs-"));
const summary = {
  zkid_noir_commit: git("rev-parse", "HEAD"),
  scope_string: SCOPE,
  smt_root: smt.root.toString(16).padStart(64, "0"),
  records: [],
};
for (const r of RECORDS) {
  const ca = makeKey(r.bits);
  const code = declarationCode({ action: r.action, scopeString: SCOPE, username: r.username, challenge: r.challenge });
  const inputs = noirCardProofInputs({
    chain: chainCase({ ca, tbs, currentTime: currentTime(r.challenge), smt }),
    key: card, scope: Buffer.from(SCOPE, "ascii"), code,
  });
  const result = await runNoir(r.circuit, inputs);
  if (!result.ok) throw new Error(`${r.circuit}: ${result.error}`);
  const dir = join(work, r.circuit);
  mkdirSync(dir);
  writeFileSync(join(dir, "witness.gz"), result.witness);
  const bytecode = join(zkid, "target", `${r.circuit}.json`);
  for (const [setting, sub] of [["noir-recursive", "zk"], ["noir-recursive-no-zk", "no-zk"]]) {
    const o = join(dir, sub);
    mkdirSync(o);
    execFileSync(bb, ["write_vk", "-b", bytecode, "-o", o, "-c", crs, "-t", setting], { stdio: "ignore" });
    if (sha256(readFileSync(join(o, "vk"))) !== VK_SHA256[r.circuit]) throw new Error(`${r.circuit}: unexpected vk (${setting})`);
    execFileSync(bb, ["prove", "-b", bytecode, "-w", join(dir, "witness.gz"), "-k", join(o, "vk"),
      "-o", o, "-c", crs, "-t", setting], { stdio: "ignore" });
  }
  copyFileSync(join(dir, "zk", "proof"), join(out, `${r.circuit}.proof`));
  copyFileSync(join(dir, "zk", "public_inputs"), join(out, `${r.circuit}.public_inputs`));
  copyFileSync(join(dir, "no-zk", "proof"), join(out, `${r.circuit}.no-zk.proof`));
  const { bits, ...record } = r;
  summary.records.push({
    ...record,
    declaration_code: code.toString("ascii"),
    issuer_modulus: "0x" + ca.modulus.toString(16),
    nullifier: BigInt(result.returnValue.nullifier).toString(16).padStart(64, "0"),
  });
}
rmSync(work, { recursive: true });
writeFileSync(join(out, "proofs.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
