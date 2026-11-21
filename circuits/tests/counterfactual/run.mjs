// Counterfactual check of tests/library-guarantees.test.mjs and its
// companions: for each guarantee, build a copy of the circuit with the line
// that holds it removed, and check that the test for it now fails (and that
// the tests it should not affect still pass).
//
//   node tests/counterfactual/run.mjs            every variant
//   node tests/counterfactual/run.mjs NAME...    only these
//   KEEP=1 node tests/counterfactual/run.mjs ... keep the builds, print where
//
// Needs `nargo compile --workspace` to have run in circuits/ (the library
// sources are copied from ~/nargo, where nargo fetched them). Uses the nargo
// of fetch-nargo.sh and the bb of find-bb.sh, and compares each variant's
// verification keys with verifier/vk/. Variants are built in a temporary
// directory outside the repository (inside it, nargo finds the repository's
// own workspace instead) and removed afterwards; the table goes to
// out/counterfactual/result.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "out", "counterfactual");
const WORK = join(tmpdir(), `circuits-counterfactual-${process.pid}`);
const NARGO_HOME = join(homedir(), "nargo", "github.com");
const LIBS = {
  noir_rsa: "zkpassport/noir_rsa/v0.12.1",
  bignum: "zkpassport/noir-bignum/v0.11.0-1",
  sha256: "noir-lang/sha256/v0.3.0",
  poseidon: "noir-lang/poseidon/v0.3.0",
};
// The pinned tools, each checked against its SHA-256 by the script that finds it.
const tool = (script) => {
  const r = spawnSync(join(ROOT, script), { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${script} failed\n${r.stderr}`);
  return dirname(r.stdout.trim());
};
const env = { ...process.env, PATH: `${tool("fetch-nargo.sh")}:${tool("find-bb.sh")}:${process.env.PATH}` };

// ---- named changes: exact text, found exactly once ------------------------
const BARRETT = "    let (q, r): ([u128; N], [u128; N]) =\n        __barrett_reduction(&to_reduce, &params.redc_param, MOD_BITS, &params.modulus);\n    (q, r)";
const PATCHES = {
  // Our own checks.
  own_no_from_array: ["lib/src/rsa.nr",
    "    let signature: RuntimeBigNum<K, BITS> = RuntimeBigNum::from_array(key, signature);\n",
    "    let signature: RuntimeBigNum<K, BITS> = RuntimeBigNum { params: key, limbs: signature };\n"],
  own_no_in_field: ["lib/src/rsa.nr", "    signature.validate_in_field();\n", ""],
  own_no_top_bit: ["lib/src/der.nr", "    assert(modulus[0] >= 0x80);\n", ""],
  own_no_tbs_len_bound: ["lib/src/der.nr", "    assert(tbs_len <= MAX_SIGNED_LEN);\n", ""],
  // Library lines (the list at the top of tests/library-guarantees.test.mjs).
  lib_no_factor_range: ["libs/bignum/src/fns/expressions.nr",
    "    lhs_terms.for_each(|lhs_limbs: [[u128; N]; LHS_N]| {\n        lhs_limbs.for_each(|term: [u128; N]| validate_in_range::<N, MOD_BITS>(&term))\n    });\n"
    + "    rhs_terms.for_each(|rhs_limbs: [[u128; N]; RHS_N]| {\n        rhs_limbs.for_each(|term: [u128; N]| validate_in_range::<N, MOD_BITS>(&term))\n    });\n", ""],
  lib_no_modulus_range: ["libs/bignum/src/params.nr", "        validate_in_range::<N, MOD_BITS>(&modulus);\n", ""],
  lib_no_top_bit: ["libs/bignum/src/params.nr",
    "        (top_limb - min_top_limb).assert_max_bit_size::<MOD_BITS - (N - 1) * 120 - 1>();\n", ""],
  lib_not_strict: ["libs/bignum/src/fns/constrained_ops.nr",
    "    // Constrain it to be strict inequality\n    assert_is_not_zero_integer(&result);\n", ""],
  lib_unsafe_bytes: ["libs/noir_rsa/src/pkcs1v15.nr",
    "    let padded_sha256_hash_bytes: [u8; (ModBits + 7) / 8] = exponentiated.to_le_bytes();",
    "    let padded_sha256_hash_bytes: [u8; (ModBits + 7) / 8] = exponentiated.to_le_bytes_unsafe();"],
  lib_poseidon_iv: ["libs/poseidon/src/poseidon2.nr",
    "        let iv: Field = (in_len as Field) * two_pow_64;\n", "        let iv: Field = two_pow_64 - two_pow_64;\n"],
  lib_poseidon_final: ["libs/poseidon/src/poseidon2.nr",
    "        if (in_len == 0) | (in_len % RATE != 0) {\n", "        if (in_len == 0) | (in_len % RATE != 0) | true {\n"],
  lib_no_sha_length: ["libs/sha256/src/sha256.nr",
    "    assert(message_size <= N);\n\n    let (h, msg_block) = process_full_blocks(msg, message_size, INITIAL_STATE);",
    "    let (h, msg_block) = process_full_blocks(msg, message_size, INITIAL_STATE);"],
  // Witness hints only (unconstrained code): the constraints, and so the
  // verification keys, must not change. The multiplication hint returns r + n
  // instead of r whenever that still fits the modulus width.
  //   intermediate: not for the last product (an encoded message starts 00 01,
  //                 so its top limb is at most 1)
  //   all:          for sig^e too
  hint_plus_n_intermediate: ["libs/bignum/src/fns/unconstrained_ops.nr", BARRETT,
    "    let (q, r): ([u128; N], [u128; N]) =\n        __barrett_reduction(&to_reduce, &params.redc_param, MOD_BITS, &params.modulus);\n"
    + "    let rp: [u128; N] = crate::fns::unconstrained_helpers::__helper_add(&r, &params.modulus);\n"
    + "    let top_bits: u128 = (MOD_BITS - (N - 1) * 120) as u128;\n"
    + "    if (rp[N - 1] < (1 << top_bits)) & (r[N - 1] > 1) { (q, rp) } else { (q, r) }"],
  hint_plus_n_all: ["libs/bignum/src/fns/unconstrained_ops.nr", BARRETT,
    "    let (q, r): ([u128; N], [u128; N]) =\n        __barrett_reduction(&to_reduce, &params.redc_param, MOD_BITS, &params.modulus);\n"
    + "    let rp: [u128; N] = crate::fns::unconstrained_helpers::__helper_add(&r, &params.modulus);\n"
    + "    let top_bits: u128 = (MOD_BITS - (N - 1) * 120) as u128;\n"
    + "    if rp[N - 1] < (1 << top_bits) { (q, rp) } else { (q, r) }"],
};

// ---- variants -------------------------------------------------------------
const G = "tests/library-guarantees.test.mjs";
const C = "tests/card_proof.test.mjs";
const V = "tests/vectors.test.mjs";
// [test file, name pattern, what must happen]
const VARIANTS = [
  { name: "base", what: "nothing removed; libraries as path dependencies", patches: [], vk: "same",
    expect: [[G, ".", "pass"], [V, ".", "pass"], [C, "\\[(honest|s\\+n|limbs|key-2048)\\]", "pass"]] },

  { name: "own_from_array", what: "rsa.nr: signature built without `from_array`", patches: ["own_no_from_array"], vk: "different",
    expect: [[G, "\\[G1-own\\]", "fail"], [G, "\\[G1-e2e\\]", "pass"], [C, "\\[limbs\\]", "pass"]] },
  { name: "lib_factor_range", what: "bignum expressions.nr: no range check of the factors of a product", patches: ["lib_no_factor_range"], vk: "same",
    expect: [[G, "\\[G1-own\\]", "pass"], [G, "\\[G1-e2e\\]", "pass"], [C, "\\[limbs\\]", "pass"]] },
  { name: "both_limb_range", what: "both of the above", patches: ["own_no_from_array", "lib_no_factor_range"], vk: "different",
    expect: [[G, "\\[G1-e2e\\]", "fail"], [C, "\\[limbs\\]", "fail"]] },

  { name: "lib_modulus_range", what: "bignum params.nr: `BigNumParams::new` without the range check of the modulus limbs", patches: ["lib_no_modulus_range"], vk: "different",
    expect: [[G, "\\[G2\\]", "fail"]] },

  { name: "lib_top_bit", what: "bignum params.nr: `BigNumParams::new` without the top-bit check", patches: ["lib_no_top_bit"], vk: "different",
    expect: [[G, "\\[G3-issuer\\]", "fail"], [G, "\\[G3-part\\]", "pass"], [G, "\\[G3-card\\]", "pass"], [C, "\\[key-2048\\]", "pass"]] },
  { name: "own_top_bit", what: "der.nr: no `modulus[0] >= 0x80`", patches: ["own_no_top_bit"], vk: "different",
    expect: [[G, "\\[G3-part\\]", "fail"], [G, "\\[G3-card\\]", "pass"], [C, "\\[key-2048\\]", "pass"]] },
  { name: "both_top_bit", what: "both of the above", patches: ["own_no_top_bit", "lib_no_top_bit"], vk: "different",
    expect: [[G, "\\[G3-card\\]", "fail"], [C, "\\[key-2048\\]", "fail"]] },

  { name: "lib_strict", what: "bignum constrained_ops.nr: `validate_gt` without `assert_is_not_zero_integer`", patches: ["lib_not_strict"], vk: "different",
    expect: [[G, "\\[G4\\]", "fail"]] },
  { name: "own_in_field", what: "rsa.nr: no `validate_in_field`", patches: ["own_no_in_field"], vk: "different",
    expect: [[G, "\\[G4\\]", "fail"], [C, "\\[s\\+n\\]", "fail"]] },

  { name: "hint_intermediate", what: "hint: intermediate products returned as r + n", patches: ["hint_plus_n_intermediate"], vk: "same",
    expect: [[C, "\\[honest\\]", "pass"]] },
  { name: "hint_all", what: "hint: every product, sig^e too, returned as r + n", patches: ["hint_plus_n_all"], vk: "same",
    expect: [[C, "\\[honest\\]", "fail"]] },
  { name: "hint_all_unsafe_bytes", what: "that hint, and noir_rsa pkcs1v15.nr with `to_le_bytes_unsafe` (no canonical check of sig^e)", patches: ["hint_plus_n_all", "lib_unsafe_bytes"], vk: "different",
    expect: [[C, "\\[honest\\]", "fail"]] },

  { name: "lib_poseidon_iv", what: "poseidon poseidon2.nr: initial value 0 instead of length * 2^64", patches: ["lib_poseidon_iv"], vk: "different",
    expect: [[V, "\\[poseidon2\\]", "fail"]] },
  { name: "lib_poseidon_final", what: "poseidon poseidon2.nr: one more permutation after a full block", patches: ["lib_poseidon_final"], vk: "different",
    expect: [[V, "\\[poseidon2\\]", "fail"]] },

  { name: "lib_sha_length", what: "sha256 sha256.nr: `sha256_var` without `assert(message_size <= N)`", patches: ["lib_no_sha_length"], vk: "different",
    expect: [[G, "\\[G7-lib\\]", "fail"], [G, "\\[G7-e2e\\]", "pass"]] },
  { name: "own_tbs_len", what: "der.nr: no `tbs_len <= MAX_SIGNED_LEN`", patches: ["own_no_tbs_len_bound"], vk: "different",
    expect: [[G, "\\[G7-e2e\\]", "fail"], [G, "\\[G7-lib\\]", "pass"]] },
];

// ---- building -------------------------------------------------------------
const MEMBERS = ["lib", "card_proof_rs2048", "card_proof_rs4096", "comparison/lib", "comparison/cert_chain_rs2048",
  "tests/probes/hash_vectors", "tests/probes/canonical_signature", "tests/probes/sha256_var"];

function replaceOnce(file, from, to) {
  const text = readFileSync(file, "utf8");
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${file}: expected the text once, found it ${count} times:\n${from}`);
  writeFileSync(file, text.replace(from, () => to));
}
const pathDep = (file, name, path) =>
  replaceOnce(file, new RegExp(`^${name} = \\{[^}]*\\}`, "m").exec(readFileSync(file, "utf8"))[0], `${name} = { path = "${path}" }`);

function build(v) {
  const dir = join(WORK, v.name);
  rmSync(dir, { recursive: true, force: true });
  for (const m of MEMBERS) cpSync(join(ROOT, m), join(dir, m), { recursive: true });
  for (const [name, at] of Object.entries(LIBS)) {
    if (!existsSync(join(NARGO_HOME, at))) throw new Error(`${join(NARGO_HOME, at)} not found: run nargo compile first`);
    cpSync(join(NARGO_HOME, at), join(dir, "libs", name), { recursive: true });
  }
  writeFileSync(join(dir, "Nargo.toml"), `[workspace]\nmembers = [\n${MEMBERS.map((m) => `    "${m}",\n`).join("")}]\n`);
  for (const name of Object.keys(LIBS)) pathDep(join(dir, "lib", "Nargo.toml"), name, `../libs/${name}`);
  pathDep(join(dir, "tests/probes/sha256_var/Nargo.toml"), "sha256", "../../../libs/sha256");
  // noir_rsa and bignum must use the same copies.
  pathDep(join(dir, "libs/noir_rsa/Nargo.toml"), "bignum", "../bignum");
  pathDep(join(dir, "libs/noir_rsa/Nargo.toml"), "sha256", "../sha256");
  pathDep(join(dir, "libs/bignum/Nargo.toml"), "poseidon", "../poseidon");
  for (const p of v.patches) {
    const [file, from, to] = PATCHES[p];
    replaceOnce(join(dir, file), from, to);
  }
  const c = spawnSync("nargo", ["compile", "--workspace"], { cwd: dir, env, encoding: "utf8" });
  if (c.status !== 0) throw new Error(`${v.name}: nargo compile failed\n${c.stderr.split("\n").filter((l) => /error/i.test(l)).slice(0, 10).join("\n")}`);
  const vks = {};
  for (const circuit of ["card_proof_rs2048", "card_proof_rs4096"]) {
    const out = join(dir, "target", "vk", circuit);
    mkdirSync(out, { recursive: true });
    const w = spawnSync("bb", ["write_vk", "-b", join(dir, "target", `${circuit}.json`), "-o", out, "-c", join(ROOT, ".crs"), "-t", "noir-recursive"], { env, encoding: "utf8" });
    if (w.status !== 0) throw new Error(`${v.name}: bb write_vk failed for ${circuit}`);
    const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
    vks[circuit] = sha(join(out, "vk")) === sha(join(ROOT, "..", "verifier", "vk", `${circuit}.vk`)) ? "same" : "different";
  }
  return { dir, vks };
}

function runTests(dir, file, pattern) {
  const r = spawnSync("node", ["--test", "--test-concurrency=1", `--test-name-pattern=${pattern}`, file],
    { cwd: ROOT, env: { ...env, CIRCUITS_TARGET: join(dir, "target") }, encoding: "utf8" });
  const count = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, "m").exec(r.stdout)?.[1] ?? -1);
  const failed = [...r.stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  return { pass: count("pass"), fail: count("fail"), failed };
}

// ---- run ------------------------------------------------------------------
const only = process.argv.slice(2);
for (const name of only) if (!VARIANTS.some((v) => v.name === name)) throw new Error(`no variant ${name}`);
const rows = [];
let unmet = 0;
for (const v of VARIANTS) {
  if (only.length && !only.includes(v.name)) continue;
  const { dir, vks } = build(v);
  const vk = Object.values(vks).every((x) => x === "same") ? "same" : Object.values(vks).every((x) => x === "different") ? "different" : "mixed";
  const vkOk = vk === v.vk;
  if (!vkOk) unmet++;
  console.log(`\n${v.name}: ${v.what}\n  verification keys: ${vk} (expected ${v.vk})${vkOk ? "" : "  <-- UNEXPECTED"}`);
  let first = true;
  for (const [file, pattern, want] of v.expect) {
    const t = runTests(dir, file, pattern);
    const got = t.fail > 0 ? "fail" : t.pass > 0 ? "pass" : "nothing ran";
    const ok = got === want;
    if (!ok) unmet++;
    const detail = `${t.pass} passed, ${t.fail} failed`;
    console.log(`  ${file} ${pattern}: ${got} (${detail}), expected ${want}${ok ? "" : "  <-- UNEXPECTED"}`);
    for (const f of t.failed) console.log(`      failed: ${f}`);
    rows.push([first ? v.name : "", first ? v.what : "", first ? `${vk}${vkOk ? "" : " (expected " + v.vk + ")"}` : "",
      `\`${pattern.replace(/\\/g, "")}\` in \`${file.replace("tests/", "")}\``, want, `${got} (${detail})`, ok ? "as expected" : "**UNEXPECTED**"]);
    first = false;
  }
  if (process.env.KEEP) console.log(`  kept: ${join(dir, "target")}`);
  else rmSync(dir, { recursive: true, force: true });
}
if (!process.env.KEEP) rmSync(WORK, { recursive: true, force: true });
const head = ["variant", "what is removed or changed", "verification keys vs. the real ones", "tests", "expected", "got", ""];
const line = (cells) => `| ${cells.join(" | ")} |`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "result.md"), [
  "# Counterfactual check", "",
  `${rows.length} checks over ${new Set(rows.map((r) => r[0]).filter(Boolean)).size} variants; ${unmet} unexpected.`, "",
  line(head), line(head.map(() => "---")), ...rows.map(line), "",
].join("\n"));
console.log(`\n${unmet} unexpected result(s). Table: out/counterfactual/result.md`);
process.exit(unmet ? 1 : 0);
