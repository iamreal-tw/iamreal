// The case-by-case comparison (ADR-0012). Every case goes to three circuits:
//
//   part        the Noir comparison circuit (comparison/) of the same shape as
//               the circom circuit: the certificate part or one signature part
//   card proof  the card proof circuit, with the rest of a card proof honest
//   circom      the circom circuit (one signature circuit, run for both kinds)
//
// All three must agree with the expected accept / reject, except the intended
// differences (ADR-0013: circom has no kind check) and one part-level
// difference (circom checks the card key's length in its certificate part
// only). Writes the table to out/equivalence.md.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildCases, CODE, NOW, SCOPE } from "./cases.mjs";
import { buildTbs, spkiOfModulus } from "./lib/cert.mjs";
import { chunkedHash, loadPoseidon2 } from "./lib/hashes.mjs";
import {
  chainCase, circomChainInputs, circomSigInputs, limbs, noirCardProofInputs, noirChainInputs, noirSigInputs, sigCase,
} from "./lib/inputs.mjs";
import { circomAvailable, ROOT, runCircom, runNoir } from "./lib/run.mjs";

const PART = { chain2048: "cert_chain_rs2048", chain4096: "cert_chain_rs4096", scope: "user_sig_scope", code: "user_sig_code" };
const CARD_PROOF = { chain2048: "card_proof_rs2048", chain4096: "card_proof_rs4096", scope: "card_proof_rs2048", code: "card_proof_rs2048" };
const CIRCOM = { chain2048: "certChainRS2048", chain4096: "certChainRS4096", scope: "userSigRS2048", code: "userSigRS2048" };
const isSig = (kind) => kind === "scope" || kind === "code";

const { cases, ca, user } = buildCases();
const rows = [];
const commits = new Map(); // case index -> { noir, circom } pk_commit

const verdict = (r) => (r === null ? "n/a" : r.ok ? "accept" : "reject");

/** The card proof inputs for a case: the case's part, and the rest honest. */
function cardProofInputs(c) {
  if (c.noCardProof) return null; // an accepted certificate whose key cannot sign (see the case's note)
  if (c.kind === "chain2048" || c.kind === "chain4096") {
    return noirCardProofInputs({ chain: c, key: user, scope: SCOPE, code: CODE });
  }
  if (c.message.length !== 31) return null; // not expressible: the input is 31 bytes
  // A key that is not 2048 bits long has no SPKI Node would export in the
  // pinned layout; write its modulus into the 256 bytes instead.
  const chain = chainCase({
    ca, tbs: buildTbs({ spki: c.key.bits === 2048 ? c.key.spki : spkiOfModulus(c.key.modulus) }), currentTime: NOW,
  });
  const position = c.kind === "scope"
    ? { scope: c.message, scopeSignature: c.signature, shiftScope: c.shiftLimb, code: CODE }
    : { scope: SCOPE, code: c.message, codeSignature: c.signature, shiftCode: c.shiftLimb };
  return noirCardProofInputs({ chain, key: c.key, ...position });
}

async function runCase(c, index) {
  let part = null;
  let cardProof = null;
  if (!c.noirNotApplicable) {
    const partInputs = isSig(c.kind) ? noirSigInputs(c, c.kind === "code" ? "declaration_code" : "scope") : noirChainInputs(c);
    if (partInputs !== null) part = await runNoir(PART[c.kind], partInputs);
    const cardInputs = cardProofInputs(c);
    if (cardInputs !== null) cardProof = await runNoir(CARD_PROOF[c.kind], cardInputs);
  }
  let circom = null;
  if (circomAvailable(CIRCOM[c.kind])) {
    const circomInputs = isSig(c.kind) ? circomSigInputs(c) : circomChainInputs(c);
    // No inputs: the case does not fit the circuit, so no proof can exist.
    circom = circomInputs === null ? { ok: false, error: "no valid inputs" } : await runCircom(CIRCOM[c.kind], circomInputs);
  }
  if (part?.ok) {
    commits.set(index, { noir: isSig(c.kind) ? part.returnValue.pk_commit : part.returnValue, circom: circom?.witness?.[1] });
  }
  return { part, cardProof, circom };
}

describe("circom and Noir agree on every case", () => {
  cases.forEach((c, index) => {
    it(`${c.source}: ${c.expect ? "accepts" : "rejects"} ${c.title}`, async () => {
      if (c.kind === "link") {
        const chain = await runCase({ ...c.chain, kind: "chain2048" }, -1);
        const scope = await runCase({ ...c.sig, kind: "scope" }, -1);
        const code = await runCase({ ...c.code, kind: "code" }, -1);
        const same = chain.part.returnValue === scope.part.returnValue.pk_commit
          && chain.part.returnValue === code.part.returnValue.pk_commit;
        const circomSame = chain.circom && scope.circom ? chain.circom.witness[1] === scope.circom.witness[1] : null;
        rows.push([c.source, c.title, "same", same ? "same" : "DIFFERENT", "n/a",
          circomSame === null ? "not run" : circomSame ? "same" : "DIFFERENT",
          "the card proof circuit has no pk_commit: the key never leaves it"]);
        assert.equal(same, true);
        if (circomSame !== null) assert.equal(circomSame, true);
        return;
      }

      const { part, cardProof, circom } = await runCase(c, index);
      const expected = c.expect ? "accept" : "reject";
      const circomExpected = (c.circomExpect ?? c.expect) ? "accept" : "reject";
      rows.push([c.source, c.title, expected, verdict(part), verdict(cardProof), circom ? verdict(circom) : "not run",
        c.noirNotApplicable ?? (c.intended ? `intended difference: ${c.intended}`
          : c.partLevel ? `part-level difference: ${c.partLevel}` : c.note ?? "")]);

      for (const r of [part, cardProof]) if (r !== null) assert.equal(verdict(r), expected, r.error);
      if (circom) assert.equal(verdict(circom), circomExpected, circom.error);

      if (c.sameCommitAs !== undefined) {
        const ref = commits.get(c.sameCommitAs);
        const mine = commits.get(index);
        assert.equal(mine.noir, ref.noir);
        if (circom) assert.equal(mine.circom, ref.circom);
      }
    });
  });

  after(() => {
    const head = ["circom test file", "case", "expected", "Noir part", "Noir card proof", "circom", "note"];
    const line = (cells) => `| ${head.map((_, i) => cells[i] ?? "").join(" | ")} |`;
    const differs = (r) => [r[3], r[4], r[5]].some((v) => !["n/a", "not run", r[2]].includes(v));
    const intended = rows.filter((r) => differs(r) && (r[6] ?? "").startsWith("intended difference"));
    const partLevel = rows.filter((r) => differs(r) && (r[6] ?? "").startsWith("part-level difference"));
    const disagree = rows.filter((r) => differs(r) && !intended.includes(r) && !partLevel.includes(r));
    const text = [
      "# Case-by-case comparison",
      "",
      `${rows.length} cases; ${intended.length} intended difference(s), ${partLevel.length} part-level difference(s), ${disagree.length} other disagreement(s).`,
      "",
      "- `Noir part`: the comparison circuit in `comparison/` that has the shape of the circom",
      "  circuit: the certificate part (`cert_chain_rs2048`, `cert_chain_rs4096`) or one of the",
      "  two signature parts (`user_sig_scope`, `user_sig_code`).",
      "- `Noir card proof`: the card proof circuit (`card_proof_rs2048`, `card_proof_rs4096`),",
      "  given the case's part and an honest rest of a card proof.",
      "- `n/a`: the case cannot be expressed in this circuit (see note). `not run`: the circom",
      "  witness generators were not found.",
      "",
      "Intended differences (ADR-0013): the Noir circuits check the first signed byte (scope",
      "string or declaration code); the circom circuit is one signature circuit with no such check.",
      "",
      "Part-level difference: a signature by a card key that is not 2048 bits long. The Noir",
      "signature part rejects it by itself. circom's signature circuit does not look at the key",
      "length; its certificate circuit does, and the key commitment ties the two, so circom",
      "rejects the same card over its three proofs. The table shows both halves.",
      "",
      "\"Same behaviour\" (ADR-0012) is judged over the whole card proof: what the Noir card proof",
      "accepts against what circom accepts over all of its proofs together. The two split the",
      "statement into different parts, so which part rejects an input can differ without any",
      "card being treated differently. A part-level difference is listed here and needs no ADR;",
      "a difference in the whole card proof is either intended (with an ADR) or a bug.",
      "",
      line(head),
      line(head.map(() => "---")),
      ...rows.map(line),
      "",
    ].join("\n");
    mkdirSync(join(ROOT, "out"), { recursive: true });
    writeFileSync(join(ROOT, "out", "equivalence.md"), text);
  });
});

// The comparison circuits' own outputs. Only the comparison needs them.
describe("comparison circuits", () => {
  it("pk_commit is the hash chain over the 18 modulus limbs and pk_blind", async () => {
    const poseidon2 = await loadPoseidon2();
    const r = await runNoir("cert_chain_rs2048", noirChainInputs(chainCase({ ca, tbs: buildTbs({ spki: user.spki }), currentTime: NOW })));
    assert.equal(BigInt(r.returnValue), chunkedHash(poseidon2, [...limbs(user.modulus, 120, 18), 12345n]));
  });

  it("user_sig_code outputs the packed declaration code and no nullifier", async () => {
    const r = await runNoir("user_sig_code", noirSigInputs(sigCase({ key: user, message: CODE }), "declaration_code"));
    assert.equal(BigInt(r.returnValue.declaration_code_packed), BigInt("0x" + Buffer.from(CODE).reverse().toString("hex")));
    assert.deepEqual(Object.keys(r.returnValue).sort(), ["declaration_code_packed", "pk_commit"]);
  });

  it("user_sig_scope gives the nullifier the card proof circuit gives", async () => {
    const part = await runNoir("user_sig_scope", noirSigInputs(sigCase({ key: user, message: SCOPE })));
    const chain = chainCase({ ca, tbs: buildTbs({ spki: user.spki }), currentTime: NOW });
    const whole = await runNoir("card_proof_rs2048", noirCardProofInputs({ chain, key: user, scope: SCOPE, code: CODE }));
    assert.equal(part.returnValue.nullifier, whole.returnValue.nullifier);
  });
});
