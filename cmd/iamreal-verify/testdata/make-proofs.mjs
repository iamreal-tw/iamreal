// Makes the real proofs of the records generate.go describes. generate.go
// runs it; see README.md.
//
//   node make-proofs.mjs <bb> <crs dir> <work dir>
//
// It reads <work dir>/input.json: the throwaway issuer keys (PKCS #8 PEM),
// one card serial number per issuer, and per record its fields and the
// serial numbers of the CRL whose root it uses. It writes
// <work dir>/output.json (per record: the root of its tree, built here with
// the reference tree of circuits/, the declaration code computed here from
// the scope string, the record's accounts and its challenge, and the
// nullifier) and <work dir>/record-<n>.proof.
//
// It uses the test helpers of circuits/ (tests/lib/) and the published
// circuits (web/circuits/, which circuits/rebuild.sh rebuilds from the
// source), as verifier/testdata/make-proofs.mjs does. Nothing is written
// into circuits/ or web/circuits/.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [bb, crs, work] = process.argv.slice(2).map((p) => resolve(p));
if (!work) throw new Error("usage: node make-proofs.mjs <bb> <crs dir> <work dir>");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const circuitFiles = join(root, "web", "circuits");
// tests/lib/run.mjs reads the circuits from CIRCUITS_TARGET when it loads.
process.env.CIRCUITS_TARGET = circuitFiles;
const lib = (f) => import(join(root, "circuits", "tests", "lib", f));
const { buildTbs, makeKey, serialOf } = await lib("cert.mjs");
const { loadPoseidon2 } = await lib("hashes.mjs");
const { chainCase, noirCardProofInputs } = await lib("inputs.mjs");
const { runNoir } = await lib("run.mjs");
const { Smt } = await lib("smt.mjs");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", "circuits", "web/circuits") !== "") {
  throw new Error("circuits/ or web/circuits/ has uncommitted changes");
}

// The verification keys of spec/record.md, "Accepted circuits".
const VK_SHA256 = {
  card_proof_rs2048: "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8",
  card_proof_rs4096: "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
};

// The declaration code of spec/declaration-code.md: the version tag, the
// scope string, one line platform:username per account in the order of the
// list, and the challenge. Written here rather than taken from circuits/,
// whose helper (tests/lib/declaration-code.mjs) computes an earlier draft.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function declarationCode({ scopeString, accounts, challenge }) {
  const lines = ["iamreal-declaration-v1", scopeString, ...accounts.map((a) => `${a.platform}:${a.username}`), challenge];
  const digest = createHash("sha256").update(lines.join("\n"), "utf8").digest();
  let bits = "";
  for (const b of digest) bits += b.toString(2).padStart(8, "0");
  bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return Buffer.from("D" + out.slice(0, 30), "ascii");
}

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
const output = { circuits_commit: git("rev-parse", "HEAD"), records: [] };
for (const [i, r] of input.records.entries()) {
  const tree = new Smt(poseidon2.hash2, poseidon2.hash3);
  for (const s of r.revoked) tree.insert(BigInt("0x" + s));
  const { key, tbs } = cards[r.issuer];
  const smt = tree.proveAbsent(serialOf(tbs));
  const code = declarationCode({ scopeString: input.scope, accounts: r.accounts, challenge: r.challenge });
  const inputs = noirCardProofInputs({
    chain: chainCase({ ca: issuers[r.issuer], tbs, currentTime: currentTime(r.challenge), smt }),
    key, scope: Buffer.from(input.scope, "ascii"), code,
  });
  const result = await runNoir(r.circuit, inputs);
  if (!result.ok) throw new Error(`record ${i + 1}: ${result.error}`);
  const dir = join(work, `record-${i + 1}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "witness.gz"), result.witness);
  const bytecode = join(circuitFiles, `${r.circuit}.json`);
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
