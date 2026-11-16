// The flow against a fake server that gives, one at a time, a value the
// device must not accept. Each time the device stops, and no request it sends
// carries the reason (ADR-0016). The proof itself is made only in the
// headless browser test (test/e2e/); here the prover's `prove` is a stub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { FakeCard } from "../src/card/fake.ts";
import { buildWith } from "../src/crl/build.ts";
import { CardProofFlow, FlowStop, type Stop } from "../src/flow.ts";
import type { IssuerName } from "../src/issuers.ts";
import { ArtifactError, loadCircuit } from "../src/prover/artifacts.ts";
import type { Prover } from "../src/prover/prover.ts";
import type { Action } from "../src/spec/declaration-code.ts";
import { memoryStore } from "../src/storage.ts";
import { pack31 } from "../src/spec/field.ts";
import { poseidon } from "./bb.ts";
import { type BackendOptions, FakeBackend } from "./fixtures/backend.ts";
import { IDP } from "./fixtures/crls.ts";
import { makeKey } from "./fixtures/der-build.ts";
import { type World, makeWorld, mirror, randomSerials } from "./fixtures/world.ts";

// 2026-11-16 12:00 in Taiwan.
const NOW = Date.UTC(2026, 10, 16, 4, 0, 0);
const CRL_TIME = new Date(Date.UTC(2026, 10, 15, 16, 30, 0)); // CRL date 2026-11-16
const daysBefore = (n: number) => new Date(CRL_TIME.getTime() - n * 86_400_000);
const PIN = "123456";
const SCOPE = "iamreal-test:threads:0_________";

const circuitFiles = new Map(
  ["card_proof_rs2048", "card_proof_rs4096"].map((c) => [`/circuits/${c}.json`, new Uint8Array(readFileSync(new URL(`../circuits/${c}.json`, import.meta.url)))]),
);

interface Setup {
  w: World;
  backend: FakeBackend;
  card: FakeCard;
  flow: CardProofFlow;
  store: ReturnType<typeof memoryStore>;
  backgroundStop: Promise<Stop>;
  proveCalls: Record<string, unknown>[];
}

async function setup(o: {
  world?: World;
  crls?: Parameters<typeof mirror>[1];
  backend?: Partial<BackendOptions>;
  remembered?: Partial<Record<IssuerName, bigint>>;
  action?: Action;
  username?: string;
  tamperCircuit?: boolean;
  engineFails?: boolean;
  /** The stub prover returns the public inputs the circuit would (the proof bytes stay zeros). */
  echoPublicInputs?: boolean;
} = {}): Promise<Setup> {
  const w = o.world ?? (await makeWorld());
  const files = new Map<string, Uint8Array>(circuitFiles);
  if (o.tamperCircuit) {
    const c = files.get("/circuits/card_proof_rs4096.json")!.slice();
    c[c.length - 3]! ^= 1;
    files.set("/circuits/card_proof_rs4096.json", c);
  }
  for (const f of await mirror(w, o.crls ?? [{ serials: randomSerials(300), crlNumber: 100n, thisUpdate: CRL_TIME }])) files.set(f.path, f.bytes);
  const backend = new FakeBackend({ files, clock: () => NOW, ...o.backend });
  const card = new FakeCard({ certificates: [w.encryptionCert, w.signingCert], signingKey: w.card.privateKey, pin: PIN });
  const p = await poseidon();
  const proveCalls: Record<string, unknown>[] = [];
  const prover: Prover = {
    ready: async () => {
      if (o.engineFails) throw new ArtifactError("/crs/bn254_g1_compressed_2p18.dat", "SHA-256 is not the expected one");
      return { multithreaded: false, threads: 1, reportedThreads: null };
    },
    hash2: async (a, b) => p.hash2(a, b),
    preloadCircuit: async (name) => void (await loadCircuit(backend.fetch, name)),
    prove: async (_name, inputs) => {
      proveCalls.push(inputs);
      if (!o.echoPublicInputs) return { proof: new Uint8Array(14_656), publicInputs: [] };
      const big = (x: unknown) => BigInt(x as string);
      let nullifier = 0n;
      for (const limb of inputs.scope_signature as string[]) nullifier = p.hash2(nullifier, big(limb));
      const publicInputs = [
        ...(inputs.issuer_modulus as string[]).map(big),
        big(inputs.smt_root),
        big(inputs.current_time),
        nullifier,
        pack31(Uint8Array.from(inputs.scope as number[])),
        pack31(Uint8Array.from(inputs.declaration_code as number[])),
      ];
      return { proof: new Uint8Array(14_656), publicInputs };
    },
  };
  const store = memoryStore(o.remembered);
  let onStop: (s: Stop) => void = () => undefined;
  const backgroundStop = new Promise<Stop>((r) => (onStop = r));
  const flow = new CardProofFlow(
    {
      roster: "test",
      issuers: w.issuers,
      fetch: backend.fetch,
      clock: () => NOW,
      store,
      card,
      prover,
      startTreeBuilder: async () => ({ build: (k, n, s) => buildWith([p.runner(), p.runner()], k, n, s), close: () => undefined }),
      onBackgroundStop: onStop,
    },
    { action: o.action ?? "declare", platform: "threads", username: o.username ?? "alice" },
  );
  return { w, backend, card, flow, store, backgroundStop, proveCalls };
}

async function stopOf(p: Promise<unknown>): Promise<Stop> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FlowStop) return e.stop;
    throw e;
  }
  assert.fail("did not stop");
}

/** No request after the stop, none submitted a record, none carries the reason. */
async function assertQuiet(s: Setup, stop: Stop, requestsAtStop: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.backend.log.length, requestsAtStop, "requests after the stop");
  assert.equal(s.backend.log.filter((r) => r.path === "/api/v1/records").length, 0, "a record was submitted");
  // The reason codes in the stop (code, problem, reason), at any depth.
  const words: string[] = [];
  const collect = (x: unknown): void => {
    if (typeof x !== "object" || x === null) return;
    for (const [k, v] of Object.entries(x)) {
      if (typeof v === "string" && ["code", "problem", "reason"].includes(k)) words.push(v);
      collect(v);
    }
  };
  collect(stop);
  assert.ok(words.length > 0);
  for (const r of s.backend.log) {
    for (const word of words) assert.ok(!(r.path + r.body).includes(word), `request ${r.method} ${r.path} carries "${word}"`);
  }
}

/** No request carried the scoped ID. */
function assertNoCardState(s: Setup): void {
  assert.equal(s.backend.log.filter((r) => r.path === "/api/v1/card-state").length, 0, "a card-state request was sent");
}

/** Card read, then the background (CRL, tree, circuit) finishes or stops. */
async function readAndWait(s: Setup): Promise<Stop | null> {
  await s.flow.readCard();
  const quiet = new Promise<null>((r) => setTimeout(() => r(null), 3000));
  return Promise.race([s.backgroundStop, quiet]);
}

describe("the flow, with a server that gives values the device must not accept", async () => {
  test("a challenge not dated today", async () => {
    const s = await setup({ backend: { challenge: () => "2026-11-15.000G40R40M30E209185GR38E1W" } });
    await s.flow.readCard();
    await s.flow.confirmCard(PIN);
    const stop = await stopOf(s.flow.proceed("alice"));
    assert.deepEqual(stop, { code: "challenge_not_today", challengeDate: "2026-11-15", today: "2026-11-16" });
    assert.equal(s.card.signed.length, 1, "the card signed only the scope string");
    await assertQuiet(s, stop, s.backend.log.length);
  });

  for (const bad of [
    "2026-11-16.000G40R40M30E209185GR38E1X",
    "2026-11-16.000g40r40m30e209185gr38e1w",
    "2026-11-16.000G40R40M30E209185GR38E1W\n",
    " 2026-11-16.000G40R40M30E209185GR38E1W",
    "2026-11-16.O00G40R40M30E209185GR38E1W",
    42,
  ]) {
    test(`a challenge not in its one spelling: ${JSON.stringify(bad)}`, async () => {
      const s = await setup({ backend: { challenge: () => bad } });
      await s.flow.readCard();
      await s.flow.confirmCard(PIN);
      const stop = await stopOf(s.flow.proceed("alice"));
      assert.deepEqual(stop, { code: "challenge_malformed" });
      assert.equal(s.card.signed.length, 1);
      await assertQuiet(s, stop, s.backend.log.length);
    });
  }

  const crlCase = async (name: string, o: Parameters<typeof setup>[0], expected: Stop, rememberedAfter?: bigint | null) =>
    test(name, async () => {
      const s = await setup(o);
      const bg = await readAndWait(s);
      assert.deepEqual(bg, expected, "the background stopped with this reason");
      const n = s.backend.log.length;
      const stop = await stopOf(s.flow.confirmCard(PIN));
      assert.deepEqual(stop, expected);
      assert.equal(s.card.signed.length, 0, "the card was not asked to sign");
      assert.equal(s.flow.phase, "stopped");
      assertNoCardState(s);
      await assertQuiet(s, stop, n);
      if (rememberedAfter !== undefined) assert.equal(s.store.values.G3 ?? null, rememberedAfter);
    });

  await crlCase(
    "a CRL signed by another key",
    { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: CRL_TIME, signWith: await makeKey(4096) }] },
    { code: "revocation", problem: { code: "crl_unusable", reason: "not_usable_signature" } },
    null,
  );
  await crlCase(
    "a CRL older than L days (server says 3)",
    { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: daysBefore(4) }] },
    { code: "revocation", problem: { code: "crl_stale", days: 4, maxDays: 3 } },
    null,
  );
  await crlCase(
    "/api/v1/config says 365: the device keeps 7",
    { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: daysBefore(8) }], backend: { crlMaxAgeDays: 365 } },
    { code: "revocation", problem: { code: "crl_stale", days: 8, maxDays: 7 } },
  );
  await crlCase(
    "a CRL number lower than the one remembered",
    { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: CRL_TIME }], remembered: { G3: 101n } },
    { code: "revocation", problem: { code: "crl_rollback", crlNumber: 100n, highest: 101n } },
    101n,
  );
  await crlCase(
    "a partitioned CRL",
    { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: CRL_TIME, extraExtensions: [IDP] }] },
    { code: "revocation", problem: { code: "crl_unusable", reason: "not_usable_partitioned" } },
  );
  await crlCase(
    "the index names a file the mirror does not have",
    { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: CRL_TIME, indexSha: "ab".repeat(32) }] },
    { code: "revocation", problem: { code: "crl_unavailable", detail: "file: http_404" } },
  );
  await crlCase("a circuit file whose SHA-256 is not the one in the page", { tamperCircuit: true }, { code: "artifact", path: "/circuits/card_proof_rs4096.json" });
  await crlCase(
    "the card's serial number is on the CRL",
    { crls: [{ serials: [...randomSerials(50), 0x1234567890abcdef1234567890abcdefn], crlNumber: 100n, thisUpdate: CRL_TIME }] },
    { code: "revoked" },
  );

  await crlCase("a CRS file whose SHA-256 is not the one in the page", { engineFails: true }, { code: "artifact", path: "/crs/bn254_g1_compressed_2p18.dat" });

  for (const [name, o, expected] of [
    ["serial on the CRL", { crls: [{ serials: [...randomSerials(50), 0x1234567890abcdef1234567890abcdefn], crlNumber: 100n, thisUpdate: CRL_TIME }] }, { code: "revoked" }],
    ["CRL not usable", { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: CRL_TIME, extraExtensions: [IDP] }] }, { code: "revocation", problem: { code: "crl_unusable", reason: "not_usable_partitioned" } }],
    ["circuit hash wrong", { tamperCircuit: true }, { code: "artifact", path: "/circuits/card_proof_rs4096.json" }],
  ] as const) {
    test(`PIN given before the checks finish (${name}): no signature, no card-state`, async () => {
      const s = await setup(o as Parameters<typeof setup>[0]);
      await s.flow.readCard();
      assert.equal(s.flow.phase, "checking");
      const stop = await stopOf(s.flow.confirmCard(PIN));
      assert.deepEqual(stop, expected);
      assert.equal(s.card.signed.length, 0, "the card was not asked to sign");
      assertNoCardState(s);
      await assertQuiet(s, stop, s.backend.log.length);
    });
  }

  test("the phase says when the PIN may be asked", async () => {
    const s = await setup();
    assert.equal(s.flow.phase, "start");
    await s.flow.readCard();
    assert.equal(s.flow.phase, "checking");
    await s.flow.checksDone();
    assert.equal(s.flow.phase, "ready_for_pin");
    assert.equal(s.card.signed.length, 0);
    assertNoCardState(s);
    await s.flow.confirmCard(PIN);
    assert.equal(s.flow.phase, "status_known");
  });

  test("the second signature needs the account the screen showed", async () => {
    const s = await setup({ action: "withdraw", backend: { cardState: { current: "alice", last_declared: "alice", last_card_proof: "2026-11-04", switch_dates: [], count: 1, head: "a".repeat(64) } } });
    await s.flow.readCard();
    await s.flow.confirmCard(PIN);
    const n = s.backend.log.length;
    assert.deepEqual(await stopOf(s.flow.proceed("bob")), { code: "state" });
    assert.equal(s.card.signed.length, 1, "no second signature");
    assert.equal(s.backend.log.length, n, "no challenge requested");
  });

  test("a submission the server refuses for good, and one that can be sent again", async () => {
    let answer = { status: 503, body: { error: "crl_stale" } as unknown };
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    await s.flow.readCard();
    await s.flow.confirmCard(PIN);
    assert.deepEqual(await stopOf(s.flow.proceed("alice")), { code: "server", server: "crl_stale", status: 503 });
    assert.notEqual(s.flow.stop, null, "crl_stale ends the flow");

    answer = { status: 500, body: { error: "internal" } };
    const t = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    await t.flow.readCard();
    await t.flow.confirmCard(PIN);
    assert.deepEqual(await stopOf(t.flow.proceed("alice")), { code: "server", server: "internal", status: 500 });
    assert.equal(t.flow.stop, null, "internal can be sent again");
    answer = { status: 201, body: { seq: 7, record_hash: "b".repeat(64), kind: "first" } };
    const done = await t.flow.resubmit();
    assert.equal(done.seq, 7);
    assert.equal(t.backend.submissions.length, 2);
    assert.equal(JSON.stringify(t.backend.submissions[0]), JSON.stringify(t.backend.submissions[1]), "the same record");
    assert.equal(t.card.signed.length, 2, "no new signature");
  });

  test("a file served under its name but with other bytes", async () => {
    const s = await setup();
    const sha = [...s.backend.opts.files.keys()].find((k) => k.endsWith(".crl"))!;
    const bytes = s.backend.opts.files.get(sha)!.slice();
    bytes[bytes.length - 1]! ^= 1;
    s.backend.opts.files.set(sha, bytes);
    const bg = await readAndWait(s);
    assert.deepEqual(bg, { code: "revocation", problem: { code: "crl_hash" } });
  });

  test("a usable CRL: its number is remembered, nothing else is stored", async () => {
    const s = await setup({ remembered: { G3: 99n } });
    assert.equal(await readAndWait(s), null);
    assert.deepEqual(s.store.values, { G3: 100n });
  });

  test("the card signs the scope string from the table; the server's answer cannot change it", async () => {
    const s = await setup({
      backend: { cardState: { current: "bob", last_declared: "bob", last_card_proof: "2026-11-04", switch_dates: ["2026-03-02"], count: 137, head: "a".repeat(64), scope_string: "iamreal:threads:0______________" } },
    });
    await s.flow.readCard();
    const status = await s.flow.confirmCard(PIN);
    assert.equal(new TextDecoder().decode(s.card.signed[0]), SCOPE);
    assert.deepEqual(status.outcome, { kind: "switch" });
    assert.equal(status.switchesLeft, 1);
    assert.equal(status.switchesLeftAfter, 0);
    const req = s.backend.log.find((r) => r.path === "/api/v1/card-state")!;
    assert.equal(req.method, "POST");
    assert.deepEqual(Object.keys(JSON.parse(req.body)), ["scope_string", "scoped_id"]);
    assert.equal(JSON.parse(req.body).scope_string, SCOPE);
  });

  test("switches used up: no second signature, no challenge", async () => {
    const s = await setup({
      backend: { cardState: { current: "bob", last_declared: "bob", last_card_proof: "2026-11-04", switch_dates: ["2026-03-02", "2026-06-01"], count: 137, head: "a".repeat(64) } },
    });
    await s.flow.readCard();
    const status = await s.flow.confirmCard(PIN);
    assert.deepEqual(status.outcome, { kind: "blocked", reason: "switch_limit" });
    assert.equal(status.nextSwitchDate, "2027-03-02");
    const n = s.backend.log.length;
    const stop = await stopOf(s.flow.proceed("alice"));
    assert.deepEqual(stop, { code: "blocked", reason: "switch_limit" });
    assert.equal(s.card.signed.length, 1);
    await assertQuiet(s, stop, n);
  });

  test("a malformed card-state answer stops the flow", async () => {
    const s = await setup({ backend: { cardState: { current: "Bob!", last_declared: null, last_card_proof: null, switch_dates: [], count: 0, head: "0".repeat(64) } } });
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), { code: "server", server: "malformed_response", status: 200 });
  });

  test("withdraw names the current account", async () => {
    const s = await setup({ action: "withdraw", backend: { cardState: { current: "alice", last_declared: "alice", last_card_proof: "2026-11-04", switch_dates: [], count: 1, head: "a".repeat(64) } } });
    await s.flow.readCard();
    const status = await s.flow.confirmCard(PIN);
    assert.deepEqual(status.outcome, { kind: "withdraw" });
    assert.equal(status.username, "alice");
  });

  test("nothing to withdraw", async () => {
    const s = await setup({ action: "withdraw" });
    await s.flow.readCard();
    const status = await s.flow.confirmCard(PIN);
    assert.deepEqual(status.outcome, { kind: "blocked", reason: "not_current" });
    assert.deepEqual(await stopOf(s.flow.proceed("alice")), { code: "blocked", reason: "not_current" });
  });

  test("a proof whose public inputs are not the device's: nothing is submitted", async () => {
    const s = await setup();
    await s.flow.readCard();
    await s.flow.confirmCard(PIN);
    const stop = await stopOf(s.flow.proceed("alice"));
    assert.deepEqual(stop, { code: "proof_check" });
    assert.equal(s.proveCalls.length, 1);
    assert.equal(s.card.signed.length, 2);
    assert.equal(new TextDecoder().decode(s.card.signed[1]).slice(0, 1), "D");
    await assertQuiet(s, stop, s.backend.log.length);
  });

  test("an expired certificate: stopped before any request", async () => {
    const s = await setup({ world: await makeWorld({ notAfter: "251231155959Z" }) });
    const stop = await stopOf(s.flow.readCard());
    assert.deepEqual(stop, { code: "certificate", problem: "expired", notAfter: "2025-12-31" });
    assert.equal(s.backend.log.length, 0);
  });

  test("a wrong PIN can be tried again", async () => {
    const s = await setup();
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.confirmCard("000000")), { code: "card", card: "pin_incorrect" });
    assert.equal(s.flow.stop, null);
    const status = await s.flow.confirmCard(PIN);
    assert.equal(status.outcome.kind, "first");
  });

  test("a username not in the format", async () => {
    const s = await setup({ username: "Alice" });
    assert.deepEqual(s.flow.stop, { code: "username" });
  });
});
