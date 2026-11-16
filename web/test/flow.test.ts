// The flow against a fake server that gives, one at a time, a value the
// device must not accept. Each time the device stops, and no request it sends
// carries the reason (ADR-0016). The proof itself is made only in the
// headless browser test (test/e2e/); here the prover's `prove` is a stub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CardError } from "../src/card/card.ts";
import { FakeCard } from "../src/card/fake.ts";
import { buildWith } from "../src/crl/build.ts";
import { CardProofFlow, type Choice, type Consequence, FlowStop, IDLE_MS, type Stop } from "../src/flow.ts";
import type { IssuerName } from "../src/issuers.ts";
import { ArtifactError, loadCircuit } from "../src/prover/artifacts.ts";
import type { Prover } from "../src/prover/prover.ts";
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
  /** The flow's clock: moves only when a test moves it. */
  advance: (ms: number) => void;
  /** Runs the flow's timers that are due, as the page's setTimeout would. */
  fireTimers: () => void;
  idleStops: Stop[];
}

/** A card that reports a blocked window for the next `n` calls of `which`, then passes calls through. */
function blockWindows(card: FakeCard, which: "readCertificates" | "sign", n: number): { blocked: () => number } {
  let left = n;
  let blocked = 0;
  const original = card[which].bind(card) as (...a: unknown[]) => Promise<unknown>;
  (card as unknown as Record<string, unknown>)[which] = async (...a: unknown[]) => {
    if (left > 0) {
      left--;
      blocked++;
      throw new CardError("popup_blocked");
    }
    return original(...a);
  };
  return { blocked: () => blocked };
}

async function setup(o: {
  world?: World;
  crls?: Parameters<typeof mirror>[1];
  backend?: Partial<BackendOptions>;
  remembered?: Partial<Record<IssuerName, bigint>>;
  tamperCircuit?: boolean;
  engineFails?: boolean;
  /** The stub prover returns the public inputs the circuit would (the proof bytes stay zeros). */
  echoPublicInputs?: boolean;
  /** Which certificate the fake card reports with each signature, like MOICA's component; none by default. */
  signer?: "signing" | "encryption";
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
  const signingCertificate = o.signer === "signing" ? w.signingCert : o.signer === "encryption" ? w.encryptionCert : undefined;
  const card = new FakeCard({ certificates: [w.encryptionCert, w.signingCert], signingKey: w.card.privateKey, pin: PIN, signingCertificate });
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
  let now = NOW;
  const timers: { at: number; f: () => void; done: boolean }[] = [];
  const idleStops: Stop[] = [];
  const flow = new CardProofFlow(
    {
      roster: "test",
      issuers: w.issuers,
      fetch: backend.fetch,
      clock: () => now,
      store,
      card,
      prover,
      startTreeBuilder: async () => ({ build: (k, n, s) => buildWith([p.runner(), p.runner()], k, n, s), close: () => undefined }),
      onBackgroundStop: onStop,
      onIdle: (s) => idleStops.push(s),
      setTimer: (ms, f) => {
        const t = { at: now + ms, f, done: false };
        timers.push(t);
        return () => (t.done = true);
      },
    },
    { platform: "threads" },
  );
  const advance = (ms: number) => (now += ms);
  const fireTimers = () => {
    for (const t of timers) {
      if (!t.done && t.at <= now) {
        t.done = true;
        t.f();
      }
    }
  };
  return { w, backend, card, flow, store, backgroundStop, proveCalls, advance, fireTimers, idleStops };
}

/** Card read, PIN given, the card's state known, `choice` picked. */
async function toChosen(s: Setup, choice: Choice = { action: "declare", username: "alice" }): Promise<Consequence> {
  await s.flow.readCard();
  await s.flow.confirmCard(PIN);
  return s.flow.choose(choice);
}

/** The flow's PIN, for tests only (it is private). */
const heldPin = (f: CardProofFlow): unknown => (f as unknown as { pin: unknown }).pin;

const cardState = (o: Partial<Record<"current" | "last_declared" | "last_card_proof", string | null>> & { switch_dates?: string[] }) => ({
  current: o.current ?? null,
  last_declared: o.last_declared ?? null,
  last_card_proof: o.last_card_proof ?? null,
  switch_dates: o.switch_dates ?? [],
  count: 137,
  head: "a".repeat(64),
});

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
    await toChosen(s);
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
      await toChosen(s);
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
    const s = await setup({ backend: { cardState: cardState({ current: "alice", last_declared: "alice", last_card_proof: "2026-11-04" }) } });
    const cq = await toChosen(s, { action: "withdraw" });
    assert.equal(cq.username, "alice");
    const n = s.backend.log.length;
    assert.deepEqual(await stopOf(s.flow.proceed("bob")), { code: "state" });
    assert.equal(s.card.signed.length, 1, "no second signature");
    assert.equal(s.backend.log.length, n, "no challenge requested");
  });

  test("a submission the server refuses for good, and one that can be sent again", async () => {
    let answer = { status: 503, body: { error: "crl_stale" } as unknown };
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    await toChosen(s);
    assert.deepEqual(await stopOf(s.flow.proceed("alice")), { code: "server", server: "crl_stale", status: 503 });
    assert.notEqual(s.flow.stop, null, "crl_stale ends the flow");

    answer = { status: 500, body: { error: "internal" } };
    const t = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    await toChosen(t);
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
      backend: { cardState: { ...cardState({ current: "bob", last_declared: "bob", last_card_proof: "2026-11-04", switch_dates: ["2026-03-02"] }), scope_string: "iamreal:threads:0______________" } },
    });
    await s.flow.readCard();
    const status = await s.flow.confirmCard(PIN);
    assert.equal(new TextDecoder().decode(s.card.signed[0]), SCOPE);
    assert.deepEqual(status.options.other, { kind: "switch" });
    assert.equal(status.switchesUsed, 1);
    assert.equal(status.switchesLeft, 1);
    assert.equal(s.flow.choose({ action: "declare", username: "alice" }).switchesLeftAfter, 0);
    const req = s.backend.log.find((r) => r.path === "/api/v1/card-state")!;
    assert.equal(req.method, "POST");
    assert.deepEqual(Object.keys(JSON.parse(req.body)), ["scope_string", "scoped_id"]);
    assert.equal(JSON.parse(req.body).scope_string, SCOPE);
  });

  test("switches used up: the engine refuses the switch itself; no second signature, no challenge", async () => {
    const s = await setup({ backend: { cardState: cardState({ current: "bob", last_declared: "bob", last_card_proof: "2026-11-04", switch_dates: ["2026-03-02", "2026-06-01"] }) } });
    await s.flow.readCard();
    const status = await s.flow.confirmCard(PIN);
    assert.deepEqual(status.options.other, { kind: "blocked", reason: "switch_limit" });
    assert.deepEqual(status.options.refresh, { kind: "refresh" });
    assert.equal(status.switchesUsed, 2);
    assert.equal(status.switchesLeft, 0);
    assert.equal(status.nextSwitchDate, "2027-03-02");
    const n = s.backend.log.length;
    let stop: Stop | null = null;
    try {
      s.flow.choose({ action: "declare", username: "alice" });
    } catch (e) {
      stop = e instanceof FlowStop ? e.stop : null;
    }
    assert.deepEqual(stop, { code: "blocked", reason: "switch_limit" });
    assert.equal(s.flow.stop, null, "the cardholder can pick again");
    assert.equal(s.flow.phase, "status_known");
    // Nothing was picked: there is nothing to sign.
    assert.deepEqual(await stopOf(s.flow.proceed("alice")), { code: "state" });
    assert.equal(s.card.signed.length, 1);
    await assertQuiet(s, stop!, n);
  });

  test("a malformed card-state answer stops the flow", async () => {
    const s = await setup({ backend: { cardState: { current: "Bob!", last_declared: null, last_card_proof: null, switch_dates: [], count: 0, head: "0".repeat(64) } } });
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), { code: "server", server: "malformed_response", status: 200 });
  });

  test("what each choice would be, from the card's state", async () => {
    const never = await setup();
    await never.flow.readCard();
    const n = await never.flow.confirmCard(PIN);
    assert.deepEqual(n.options, { refresh: null, declareBack: null, other: { kind: "first" }, withdraw: null });
    assert.deepEqual([n.switchesUsed, n.switchesLeft, n.nextSwitchDate], [0, 2, "2026-11-16"]);
    assert.deepEqual(never.flow.choose({ action: "declare", username: "alice" }), { action: "declare", username: "alice", kind: "first", switchesLeftAfter: 2, today: "2026-11-16" });

    const declared = await setup({ backend: { cardState: cardState({ current: "alice", last_declared: "alice", last_card_proof: "2026-11-04", switch_dates: ["2025-11-17"] }) } });
    await declared.flow.readCard();
    const d = await declared.flow.confirmCard(PIN);
    assert.deepEqual(d.options, { refresh: { kind: "refresh" }, declareBack: null, other: { kind: "switch" }, withdraw: { kind: "withdraw" } });
    // A switch dated 364 days ago is in the window; one 365 days ago is not.
    assert.deepEqual([d.switchesUsed, d.switchesLeft, d.lastCardProof], [1, 1, "2026-11-04"]);
    assert.equal(declared.flow.choose({ action: "declare", username: "alice" }).kind, "refresh");
    assert.deepEqual(declared.flow.choose({ action: "withdraw" }), { action: "withdraw", username: "alice", kind: "withdraw", switchesLeftAfter: 1, today: "2026-11-16" });

    // Withdrawn: the same account again is not a switch; another one is.
    const withdrawn = await setup({ backend: { cardState: cardState({ current: null, last_declared: "bob", last_card_proof: "2026-11-10", switch_dates: ["2025-11-16"] }) } });
    await withdrawn.flow.readCard();
    const w = await withdrawn.flow.confirmCard(PIN);
    assert.deepEqual(w.options, { refresh: null, declareBack: { kind: "refresh" }, other: { kind: "switch" }, withdraw: null });
    assert.deepEqual([w.switchesUsed, w.switchesLeft], [0, 2]);
    assert.equal(withdrawn.flow.choose({ action: "declare", username: "bob" }).kind, "refresh");
    const sw = withdrawn.flow.choose({ action: "declare", username: "carol" });
    assert.deepEqual([sw.kind, sw.switchesLeftAfter], ["switch", 1]);
  });

  test("nothing to withdraw: the engine refuses it", async () => {
    const s = await setup();
    await s.flow.readCard();
    await s.flow.confirmCard(PIN);
    assert.throws(() => s.flow.choose({ action: "withdraw" }), (e) => e instanceof FlowStop && e.stop.code === "blocked" && e.stop.reason === "not_current");
    assert.equal(s.flow.stop, null);
    assert.equal(s.card.signed.length, 1);
  });

  test("an account not in the format: refused, and the cardholder can type again", async () => {
    const s = await setup();
    await s.flow.readCard();
    await s.flow.confirmCard(PIN);
    for (const bad of ["Alice", "", "a".repeat(31), "al ice"]) {
      assert.throws(() => s.flow.choose({ action: "declare", username: bad }), (e) => e instanceof FlowStop && e.stop.code === "username", bad);
    }
    assert.equal(s.flow.stop, null);
    assert.equal(s.flow.choose({ action: "declare", username: "alice" }).kind, "first");
  });

  test("back and forth between the card's state and the consequence: nothing signed or asked again", async () => {
    const s = await setup({ echoPublicInputs: true, backend: { cardState: cardState({ current: "alice", last_declared: "alice", last_card_proof: "2026-11-04" }) } });
    await toChosen(s, { action: "declare", username: "bob" });
    const requests = s.backend.log.length;
    assert.equal(s.flow.back().current, "alice");
    assert.equal(s.flow.phase, "status_known");
    assert.equal(s.flow.choose({ action: "withdraw" }).kind, "withdraw");
    s.flow.back();
    assert.equal(s.flow.choose({ action: "declare", username: "alice" }).kind, "refresh");
    assert.equal(s.card.signed.length, 1, "one signature so far");
    assert.equal(s.backend.log.length, requests, "no request while picking");
    // The record is the last choice.
    await s.flow.proceed("alice");
    const sub = s.backend.submissions[0]!;
    assert.deepEqual([sub.action, sub.username], ["declare", "alice"]);
    assert.equal(s.card.signed.length, 2);
    assert.equal(s.backend.log.filter((r) => r.path === "/api/v1/card-state").length, 1);
  });

  test("the PIN waits at most 5 minutes for the second signature", async () => {
    assert.equal(IDLE_MS, 5 * 60_000);
    // Just under: everything goes on.
    const s = await setup({ echoPublicInputs: true });
    await toChosen(s);
    s.advance(IDLE_MS - 1);
    s.fireTimers();
    assert.equal(s.flow.stop, null);
    s.flow.back();
    s.flow.choose({ action: "declare", username: "alice" });
    await s.flow.proceed("alice");
    assert.equal(s.card.signed.length, 2);
    assert.equal(heldPin(s.flow), null, "the PIN is dropped after the second signature");

    // The timer fires: the PIN, the certificate and the signature are dropped; the screen is told.
    const t = await setup();
    await t.flow.readCard();
    await t.flow.confirmCard(PIN);
    assert.equal(heldPin(t.flow), PIN, "held between the two signatures");
    const n = t.backend.log.length;
    t.advance(IDLE_MS);
    t.fireTimers();
    assert.deepEqual(t.flow.stop, { code: "idle" });
    assert.deepEqual(t.idleStops, [{ code: "idle" }]);
    assert.equal(t.flow.phase, "stopped");
    assert.equal(heldPin(t.flow), null);
    const held = t.flow as unknown as { cert: unknown; scopeSignature: unknown };
    assert.equal(held.cert, null);
    assert.equal(held.scopeSignature, null);
    assert.deepEqual(await stopOf(t.flow.proceed("alice")), { code: "idle" });
    assert.throws(() => t.flow.choose({ action: "declare", username: "alice" }), (e) => e instanceof FlowStop && e.stop.code === "idle");
    assert.equal(t.card.signed.length, 1);
    assert.equal(t.backend.log.length, n, "no request after");

    // The timer did not fire (a throttled background tab): the next step checks the time itself.
    const u = await setup();
    await toChosen(u);
    u.advance(IDLE_MS + 60_000);
    assert.deepEqual(await stopOf(u.flow.proceed("alice")), { code: "idle" });
    assert.deepEqual(u.idleStops, [{ code: "idle" }]);
    assert.equal(u.card.signed.length, 1);
    assert.equal(heldPin(u.flow), null);
  });

  test("cancel (取消 on sections 3 and 4): the PIN, the certificate and the signature are dropped, as when the wait runs out", async () => {
    type Held = { pin: unknown; cert: { der: Uint8Array; tbs: Uint8Array; issuerSignature: Uint8Array } | null; scopeSignature: Uint8Array | null };
    for (const where of ["status_known", "chosen"] as const) {
      const s = await setup();
      await s.flow.readCard();
      await s.flow.confirmCard(PIN);
      if (where === "chosen") s.flow.choose({ action: "declare", username: "alice" });
      assert.equal(s.flow.phase, where);
      const held = s.flow as unknown as Held;
      const cert = held.cert!;
      const sig = held.scopeSignature!;
      assert.ok(cert.der.some((b) => b !== 0) && sig.some((b) => b !== 0));
      const n = s.backend.log.length;
      s.flow.cancel();
      assert.equal(s.flow.phase, "stopped", where);
      assert.equal(heldPin(s.flow), null, `${where}: the PIN`);
      assert.equal(held.cert, null, `${where}: the certificate`);
      assert.equal(held.scopeSignature, null, `${where}: the signature`);
      assert.ok([cert.der, cert.tbs, cert.issuerSignature, sig].every((b) => b.every((x) => x === 0)), `${where}: their bytes are zeros`);
      assert.equal(s.flow.cardStatus, null, `${where}: the card's state`);
      // The timer of the wait is gone: it does not fire later.
      s.advance(IDLE_MS);
      s.fireTimers();
      assert.deepEqual(s.idleStops, [], `${where}: no idle afterwards`);
      assert.throws(() => s.flow.choose({ action: "declare", username: "alice" }), (e) => e instanceof FlowStop);
      assert.ok((await stopOf(s.flow.proceed("alice"))) !== null);
      assert.equal(s.card.signed.length, 1, `${where}: the card signed once`);
      assert.equal(s.backend.log.length, n, `${where}: no request after`);
    }
  });

  test("a blocked window, on each of the three clicks: nothing reaches the card, and the same step goes on", async () => {
    const s = await setup({ echoPublicInputs: true });
    // Reading the card.
    const read = blockWindows(s.card, "readCertificates", 1);
    assert.deepEqual(await stopOf(s.flow.readCard()), { code: "card", card: "popup_blocked" });
    assert.equal(read.blocked(), 1);
    assert.equal(s.flow.stop, null);
    assert.equal(s.flow.phase, "start");
    assert.equal(s.backend.log.length, 0, "no request");
    await s.flow.readCard();
    // The first signature: the PIN is not kept.
    const first = blockWindows(s.card, "sign", 1);
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), { code: "card", card: "popup_blocked" });
    assert.equal(first.blocked(), 1);
    assert.equal(s.flow.stop, null);
    assert.equal(heldPin(s.flow), null, "the PIN is not kept after a blocked window");
    assertNoCardState(s);
    await s.flow.confirmCard(PIN);
    s.flow.choose({ action: "declare", username: "alice" });
    // The second signature: the PIN stays as it was, between the two signatures.
    const second = blockWindows(s.card, "sign", 1);
    assert.deepEqual(await stopOf(s.flow.proceed("alice")), { code: "card", card: "popup_blocked" });
    assert.equal(second.blocked(), 1);
    assert.equal(s.flow.stop, null);
    assert.equal(s.flow.phase, "chosen");
    assert.equal(s.card.signed.length, 1, "the card signed once");
    assert.equal(s.backend.submissions.length, 0);
    // A blocked window does not stretch the wait for the second signature.
    s.advance(IDLE_MS);
    assert.deepEqual(await stopOf(s.flow.proceed("alice")), { code: "idle" });

    const t = await setup({ echoPublicInputs: true });
    await toChosen(t);
    blockWindows(t.card, "sign", 1);
    await stopOf(t.flow.proceed("alice"));
    const done = await t.flow.proceed("alice");
    assert.equal(done.kind, "first");
    assert.equal(t.card.signed.length, 2);
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
    assert.equal(heldPin(s.flow), null);
    const status = await s.flow.confirmCard(PIN);
    assert.equal(status.options.other.kind, "first");
  });

  test("a certificate not yet valid: stopped before any request, with the date", async () => {
    const s = await setup({ world: await makeWorld({ notBefore: "261130160000Z" }) });
    const stop = await stopOf(s.flow.readCard());
    assert.deepEqual(stop, { code: "certificate", problem: "not_yet_valid", notBefore: "2026-12-01" });
    assert.equal(s.backend.log.length, 0);
  });

  test("the certificate the card's reader says signed: the chosen one goes on, another stops", async () => {
    const own = await setup({ signer: "signing" });
    await own.flow.readCard();
    assert.equal((await own.flow.confirmCard(PIN)).options.other.kind, "first");

    const other = await setup({ signer: "encryption" });
    await other.flow.readCard();
    await other.flow.checksDone();
    const n = other.backend.log.length;
    const stop = await stopOf(other.flow.confirmCard(PIN));
    assert.deepEqual(stop, { code: "card", card: "card_error", detail: "certificate_mismatch" });
    assert.equal(other.flow.phase, "stopped");
    assertNoCardState(other);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(other.backend.log.length, n, "requests after the stop");
  });

  test("a card error's code reaches the screen", async () => {
    const s = await setup();
    s.card.sign = async () => {
      throw new CardError("card_error", "7600000f");
    };
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), { code: "card", card: "card_error", detail: "7600000f" });
  });
});
