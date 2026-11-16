// Makes the real proofs of the records generate.go describes. generate.go
// runs it; see README.md.
//
//   node make-proofs.mjs <zkid-noir checkout> <bb> <crs dir> <work dir>
//
// It reads <work dir>/input.json: the throwaway issuer keys (PKCS #8 PEM),
// one card serial number per issuer, and per record its fields and the
// serial numbers of the CRL whose root it uses. It writes
// <work dir>/output.json (per record: the root of its tree, built here with
// zkid-noir's reference tree, the declaration code and the nullifier) and
// <work dir>/record-<n>.proof.
//
// It uses the test helpers of zkid-noir (tests/lib/) and its compiled
// circuits (target/), as verifier/testdata/make-proofs.mjs does. Nothing is
// written into the zkid-noir checkout.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [zkid, bb, crs, work] = process.argv.slice(2).map((p) => resolve(p));
if (!work) throw new Error("usage: node make-proofs.mjs <zkid-noir> <bb> <crs dir> <work dir>");
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

// current_time: the last second of the challenge's date in Taiwan, in UTC.
const currentTime = (challenge) => BigInt(challenge.slice(2, 4) + challenge.slice(5, 7) + challenge.slice(8, 10) + "155959");

const input = JSON.parse(readFileSync(join(work, "input.json"), "utf8"));

// The issuer keys come from generate.go, which also signs the CRLs with them.
const issuers = {};
for (const [name, k] of Object.entries(input.issuers)) {
  const privateKey = createPrivateKey(k.key_pem);
  const publicKey = createPublicKey(privateKey);
  const modulus = BigInt("0x" + Buffer.from(publicKey.export({ format: "jwk" }).n, "base64url").toString("hex"));
  issuers[name] = { privateKey, modulus, bits: k.bits, spki: publicKey.export({ format: "der", type: "spki" }) };
}

// One card per issuer, with the serial number generate.go chose.
const cards = {};
for (const [issuer, c] of Object.entries(input.cards)) {
  const key = makeKey(2048);
  const tbs = buildTbs({ spki: key.spki, serial: Buffer.from(c.serial, "hex"), notBefore: "260101000000Z", notAfter: "310101155959Z" });
  if (serialOf(tbs).toString(16) !== BigInt("0x" + c.serial).toString(16)) throw new Error("serial");
  cards[issuer] = { key, tbs };
}

const poseidon2 = await loadPoseidon2();
const vkDone = {};
const output = { zkid_noir_commit: git("rev-parse", "HEAD"), records: [] };
for (const [i, r] of input.records.entries()) {
  const tree = new Smt(poseidon2.hash2, poseidon2.hash3);
  for (const s of r.revoked) tree.insert(BigInt("0x" + s));
  const { key, tbs } = cards[r.issuer];
  const smt = tree.proveAbsent(serialOf(tbs));
  const code = declarationCode({ action: r.action, scopeString: input.scope, username: r.username, challenge: r.challenge });
  const inputs = noirCardProofInputs({
    chain: chainCase({ ca: issuers[r.issuer], tbs, currentTime: currentTime(r.challenge), smt }),
    key, scope: Buffer.from(input.scope, "ascii"), code,
  });
  const result = await runNoir(r.circuit, inputs);
  if (!result.ok) throw new Error(`record ${i + 1}: ${result.error}`);
  const dir = join(work, `record-${i + 1}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "witness.gz"), result.witness);
  const bytecode = join(zkid, "target", `${r.circuit}.json`);
  const vkDir = join(work, `vk-${r.circuit}`);
  if (!vkDone[r.circuit]) {
    mkdirSync(vkDir);
    execFileSync(bb, ["write_vk", "-b", bytecode, "-o", vkDir, "-c", crs, "-t", "noir-recursive"], { stdio: "ignore" });
    if (sha256(readFileSync(join(vkDir, "vk"))) !== VK_SHA256[r.circuit]) throw new Error(`${r.circuit}: unexpected vk`);
    vkDone[r.circuit] = true;
  }
  execFileSync(bb, ["prove", "-b", bytecode, "-w", join(dir, "witness.gz"), "-k", join(vkDir, "vk"),
    "-o", dir, "-c", crs, "-t", "noir-recursive"], { stdio: "ignore" });
  writeFileSync(join(work, `record-${i + 1}.proof`), readFileSync(join(dir, "proof")));
  output.records.push({
    smt_root: smt.root.toString(16).padStart(64, "0"),
    declaration_code: code.toString("ascii"),
    nullifier: BigInt(result.returnValue.nullifier).toString(16).padStart(64, "0"),
  });
  console.error(`record ${i + 1}: proved`);
}
writeFileSync(join(work, "output.json"), JSON.stringify(output, null, 2) + "\n");
process.exit(0);
