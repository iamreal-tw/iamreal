// The whole way with real proofs (cmd/iamreal-verify/testdata/card-proofs/,
// its README.md): the mirror fetches the CRLs from a fake MOICA, the back end
// issues the challenges the fourteen card proofs were made for, verifies each
// proof with the verifier the deployed Worker has, and accepts or refuses it
// as card-proofs.json there says. Nothing here stands in for the verifier.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { CARD_PROOF_TESTDATA, cardProofIssuers } from "./crls.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { type Submission, cardState, checkProofLog, kindsOf, submit } from "./records.ts";

interface CardProof {
  /** The back end's clock, in Taiwan time. */
  readonly at: string;
  /** The 16 random bytes of the challenge, in hex. */
  readonly random: string;
  readonly body: Submission;
  readonly status: number;
  /** The kinds as `kindsOf` writes them, or the error code. */
  readonly result: string;
}

const cardProofs = JSON.parse(readFileSync(join(CARD_PROOF_TESTDATA, "card-proofs.json"), "utf8")) as CardProof[];
const crl = (name: string): Uint8Array => new Uint8Array(readFileSync(join(CARD_PROOF_TESTDATA, "crl", name)));

describe("fourteen card proofs with real proofs, from the challenge to the proof log", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker({ issuers: cardProofIssuers() });
    // MOICA publishes A (G2) and B (G3) on 2026-11-20, C (G3) on 2026-11-21.
    worker.moica.serve("G2", crl("A-G2.crl"));
    worker.moica.serve("G3", crl("B-G3.crl"));
    await worker.setClock(new Date("2026-11-20T09:00:00+08:00"));
    assert.equal((await worker.runSchedule()).outcome, "ok");
  });
  after(() => worker.close());

  test("each is answered as card-proofs.json says, and a proof submitted with another list is `proof`", async () => {
    assert.equal(cardProofs.length, 14);
    let seq = 0;
    let servesC = false;
    const written: { body: Submission; recordHash: string }[] = [];
    for (const [i, p] of cardProofs.entries()) {
      const what = `card proof ${i + 1}`;
      await worker.setClock(new Date(p.at));
      if (p.at.startsWith("2026-11-21") && !servesC) {
        worker.moica.serve("G3", crl("C-G3.crl"));
        assert.equal((await worker.runSchedule()).outcome, "ok");
        servesC = true;
      }
      assert.equal(await worker.issueChallenge(p.random), p.body.challenge, what);
      if (p.status === 201 && p.body.accounts.length > 0) {
        // The declaration code is computed from the whole list: the same proof with another list does not verify.
        const renamed = p.body.accounts.map((a, at) => (at === p.body.accounts.length - 1 ? { ...a, username: "carl" } : a));
        assert.deepEqual(await submit(worker, { ...p.body, accounts: renamed }), { status: 400, body: { error: "proof" } }, `${what}, an account renamed`);
        if (p.body.accounts.length === 2) {
          assert.deepEqual(await submit(worker, { ...p.body, accounts: p.body.accounts.slice(1) }), { status: 400, body: { error: "proof" } }, `${what}, one account fewer`);
          // The same list in the other order: the back end does not sort it.
          assert.deepEqual(await submit(worker, { ...p.body, accounts: [p.body.accounts[1]!, p.body.accounts[0]!] }), { status: 400, body: { error: "malformed" } }, `${what}, the other order`);
        }
      }
      const answer = await submit(worker, p.body);
      assert.equal(answer.status, p.status, `${what}: ${JSON.stringify(answer.body)}`);
      if (p.status === 201) {
        assert.equal(kindsOf(answer.body), p.result, what);
        assert.equal(answer.body.seq, ++seq, what);
        written.push({ body: p.body, recordHash: answer.body.record_hash });
      } else assert.deepEqual(answer.body, { error: p.result }, what);
    }
    assert.equal(seq, 11);

    // What is stored, computed again from the stored lines alone (spec/record.md): the testdata has no record hashes
    // to compare with, so the lines, their hashes and the proof log fingerprint are checked as a log file is. Each
    // line is the accepted submission, and its stored hash the one the `201` gave.
    const stored = await checkProofLog(worker);
    assert.deepEqual(
      stored.map(({ seq: _, ...fields }) => fields),
      written.map(({ body: b }) => ({ scopeString: b.scope_string, scopedId: b.scoped_id, accounts: b.accounts, challenge: b.challenge, issuer: b.issuer, smtRoot: b.smt_root, circuit: b.circuit, proof: b.proof })),
    );
    assert.deepEqual((await worker.proofLog.stored()).records.map((r) => r.record_hash), written.map((w) => w.recordHash));

    // The state the back end answers.
    const never = { current: null, last_declared: null, switch_count: 0 };
    assert.deepEqual(await cardState(worker, cardProofs[0]!.body.scoped_id), {
      last_card_proof: "2026-11-23",
      proofs_on_last_date: 1,
      daily_limit: 3,
      platforms: { "test-example": never, threads: { current: null, last_declared: "alice", switch_count: 0 } },
      count: 11,
    });
    // threads: alice_ on the day of alice (card proof 3) is the first of its five switches.
    assert.deepEqual(await cardState(worker, cardProofs[1]!.body.scoped_id), {
      last_card_proof: "2026-11-24",
      proofs_on_last_date: 3,
      daily_limit: 3,
      platforms: {
        "test-example": { current: null, last_declared: "c-d", switch_count: 1 },
        threads: { current: null, last_declared: "erin", switch_count: 5 },
      },
      count: 11,
    });
  });

  // The proof log the test above wrote, published, and re-verified by the command as anyone runs it: built from
  // cmd/iamreal-verify, with the native `bb` verifying every proof again. Its one option beyond the default reading is
  // the test build's `-test-issuers`, for the throwaway keys the testdata's cards and CRLs are signed by.
  const bb = process.env.IAMREAL_BB;
  const hasGo = spawnSync("go", ["version"]).status === 0;
  test("published at the next midnight, the proof log passes Go's iamreal-verify with the native bb: every proof, the CRL archive, the card state file", { skip: bb === undefined ? "IAMREAL_BB is not set" : false }, async () => {
    assert.ok(hasGo, "IAMREAL_BB is set and go is not installed: this must run here");
    await worker.setClock(new Date("2026-11-25T00:00:05+08:00"));
    await worker.proofLog.runAlarm();
    const files = await worker.files();
    // The object's own alarm may have published on an earlier date of the test above, when that took long enough for
    // it to ring: there is then a line and a card state file for that date too. The last line is today's either way.
    const names = files.map((f) => f.key);
    for (const name of ["proof-log/0000000000000000.jsonl", "proof-log/card-state/2026-11-25.jsonl", "proof-log/fingerprints.jsonl", "proof-log/hashes/0000000000000000.txt"]) assert.ok(names.includes(name), name);
    assert.match(new TextDecoder().decode(files.find((f) => f.key === "proof-log/fingerprints.jsonl")!.bytes), /\{"date":"2026-11-25","count":11,"fingerprint":"[0-9a-f]{64}"\}\n$/);

    mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
    const out = mkdtempSync(join(WORKER_DIR, "test-output", "published-real-"));
    try {
      for (const f of files) {
        mkdirSync(dirname(join(out, "data", f.key)), { recursive: true });
        writeFileSync(join(out, "data", f.key), f.bytes);
      }
      // bb verify reads only the first G1 point of the CRS, (1, 2) (spec/proof-verification.md, "The CRS").
      mkdirSync(join(out, "crs"));
      const point = Buffer.alloc(64);
      point[31] = 1;
      point[63] = 2;
      writeFileSync(join(out, "crs", "bn254_g1.dat"), point);
      const command = join(out, "iamreal-verify");
      const build = spawnSync("go", ["build", "-tags", "iamrealtest", "-o", command, "./cmd/iamreal-verify"], { cwd: join(WORKER_DIR, ".."), encoding: "utf8" });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(command, ["-bb", bb!, "-crs", join(out, "crs"), "-proof-log", "test", "-json", "-test-issuers", CARD_PROOF_TESTDATA, "-data", join(out, "data")], { encoding: "utf8" });
      assert.equal(run.status, 0, `${run.stdout.slice(0, 2000)}\n${run.stderr}`);
      const verified = JSON.parse(run.stdout) as { valid: boolean; results: { seq: number; valid: boolean }[] };
      assert.equal(verified.valid, true);
      assert.deepEqual(verified.results.map((r) => [r.seq, r.valid]), Array.from({ length: 11 }, (_, i) => [i + 1, true]));
      assert.match(run.stderr, /fingerprints\.jsonl: [1-5] line\(s\), every fingerprint is the proof log's/);
      assert.match(run.stderr, /hashes\/: 1 list\(s\), every list is the proof log's/);
      assert.ok(run.stderr.includes("card-state/2026-11-25.jsonl: count 11 of fingerprints.jsonl, 11 record(s) re-verified: 2 card(s) the same, 0 skipped\n"), run.stderr);
      rmSync(out, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\nThe copy of the bucket is kept in ${out}`, { cause: e });
    }
  });
});
