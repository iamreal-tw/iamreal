// The flow against a fake server that gives, one at a time, a value the
// device must not accept. Each time the device stops, and the only request
// that carries the reason is a count, which holds one code of the table for
// it and nothing else (ADR-0032; spec/counts.md). The proof itself is made
// only in the headless browser test (test/e2e/); here the prover's `prove`
// is a stub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CardError } from "../src/card/card.ts";
import { FakeCard } from "../src/card/fake.ts";
import { buildWith } from "../src/crl/build.ts";
import { DEVICE_ID_KEY, type FlowCounts, cardProofCounts, reasonOf } from "../src/counts.ts";
import { CardProofFlow, type CardStatus, type Choice, type Consequence, FlowStop, HELD_CHALLENGE_MS, IDLE_MS, type Progress, type Stop } from "../src/flow.ts";
import type { IssuerName } from "../src/issuers.ts";
import { ArtifactError, loadCircuit } from "../src/prover/artifacts.ts";
import type { Prover } from "../src/prover/prover.ts";
import { memoryStore } from "../src/storage.ts";
import { readCount } from "iamreal-protocol/counts.ts";
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { declarationCode } from "iamreal-protocol/declaration-code.ts";
import { pack31 } from "iamreal-protocol/field.ts";
import { poseidon } from "./bb.ts";
import { type BackendOptions, FakeBackend } from "./fixtures/backend.ts";
import { IDP } from "./fixtures/crls.ts";
import { makeKey } from "./fixtures/der-build.ts";
import { withoutRandomIds } from "./random-ids.ts";
import { type World, makeWorld, mirror, randomSerials } from "./fixtures/world.ts";

// 2026-11-16 12:00 in Taiwan.
const NOW = Date.UTC(2026, 10, 16, 4, 0, 0);
const CRL_TIME = new Date(Date.UTC(2026, 10, 15, 16, 30, 0)); // CRL date 2026-11-16
const daysBefore = (n: number) => new Date(CRL_TIME.getTime() - n * 86_400_000);
const PIN = "123456";
const SCOPE = "iamreal-test:public:0__________";

const circuitFiles = new Map(
  ["card_proof_rs2048", "card_proof_rs4096"].map((c) => [`/circuits/${c}.json`, new Uint8Array(readFileSync(new URL(`../circuits/${c}.json`, import.meta.url)))]),
);

interface Setup {
  w: World;
  backend: FakeBackend;
  /** The data domain (ADR-0027): the CRL archive's files, and nothing else. */
  data: FakeBackend;
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
  /** The flow's onProgress events, in order. */
  progress: Progress[];
  prover: Prover;
  /**
   * Holds the server's answers on `path`: the request reaches the server (and
   * its log) at once, the answer only when the returned function is called.
   */
  hold: (path: string) => () => void;
  /**
   * The counts the page sent (`POST /api/v1/counts`), in order, each as it
   * was sent. They are not in the server's log (`backend.log`): that is every
   * other request.
   */
  counted: Record<string, unknown>[];
  /** The page's counts: another flow given them is another card proof on the same page. */
  counts: FlowCounts;
  /** What the page keeps in `localStorage` for the counts. */
  idStorage: Map<string, string>;
  /** The requests the server had got (`METHOD path`) when the page first asked the data domain for a file; null before. */
  beforeCrl: () => string[] | null;
}

/** The `User-Agent` of the page in these tests: Chrome on Windows. */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
  /** The platforms the page has its own definition of; the test log's two by default. */
  knownPlatforms?: string[];
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
  /** The flow's clock at the start; NOW by default. */
  start?: number;
  /** What becomes of a count the page sends: answered (by default), refused by the network, or never answered. */
  countsAre?: "answered" | "failing" | "held";
  /** The card reader's name the card reports; none by default. */
  readerName?: string;
  /** Until it settles, the CRL's files are not answered. */
  crlHeld?: Promise<void>;
  /** How long the flow's clock moves while each timed step runs, in milliseconds; not at all by default. */
  takes?: { crl?: number; tree?: number; proved?: number };
} = {}): Promise<Setup> {
  const w = o.world ?? (await makeWorld());
  const files = new Map<string, Uint8Array>(circuitFiles);
  if (o.tamperCircuit) {
    const c = files.get("/circuits/card_proof_rs4096.json")!.slice();
    c[c.length - 3]! ^= 1;
    files.set("/circuits/card_proof_rs4096.json", c);
  }
  const crlFiles = new Map<string, Uint8Array>();
  for (const f of await mirror(w, o.crls ?? [{ serials: randomSerials(300), crlNumber: 100n, thisUpdate: CRL_TIME }])) crlFiles.set(f.path, f.bytes);
  const backend = new FakeBackend({ files, clock: () => NOW, ...o.backend });
  const data = new FakeBackend({ files: crlFiles, clock: () => NOW });
  const signingCertificate = o.signer === "signing" ? w.signingCert : o.signer === "encryption" ? w.encryptionCert : undefined;
  const card = new FakeCard({ certificates: [w.encryptionCert, w.signingCert], signingKey: w.card.privateKey, pin: PIN, signingCertificate, readerName: o.readerName });
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
      // After the step began: the flow reads its clock once the call returns.
      await Promise.resolve();
      now += o.takes?.proved ?? 0;
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
  let now = o.start ?? NOW;
  const gates = new Map<string, Promise<void>>();
  const hold = (path: string): (() => void) => {
    let open!: () => void;
    gates.set(path, new Promise<void>((r) => (open = r)));
    return () => {
      gates.delete(path);
      open();
    };
  };
  const gatedFetch: typeof backend.fetch = async (path, init) => {
    const res = await backend.fetch(path, init);
    await gates.get(path);
    return res;
  };
  const counted: Record<string, unknown>[] = [];
  const idStorage = new Map<string, string>();
  const counts = cardProofCounts({
    fetch: async (path, init) => {
      assert.deepEqual([path, init?.method], ["/api/v1/counts", "POST"]);
      counted.push(JSON.parse(init!.body!) as Record<string, unknown>);
      if (o.countsAre === "failing") throw new TypeError("Failed to fetch");
      if (o.countsAre === "held") return new Promise<Response>(() => undefined);
      return new Response(null, { status: 204 });
    },
    storage: { getItem: (k) => idStorage.get(k) ?? null, setItem: (k, v) => void idStorage.set(k, v) },
    clock: () => now,
    random: (bytes) => crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
    userAgent: USER_AGENT,
  });
  const timers: { at: number; f: () => void; done: boolean }[] = [];
  let crlTaken = false;
  let beforeCrl: string[] | null = null;
  const idleStops: Stop[] = [];
  const progress: Progress[] = [];
  const flow = new CardProofFlow(
    {
      proofLog: "test",
      issuers: w.issuers,
      knownPlatforms: new Set(o.knownPlatforms ?? ["test-example", "threads"]),
      fetch: gatedFetch,
      dataFetch: async (path, init) => {
        beforeCrl ??= backend.log.map((r) => `${r.method} ${r.path}`);
        await o.crlHeld;
        const res = await data.fetch(path, init);
        // The CRL's first file: the clock moves once, while the CRL is fetched.
        if (!crlTaken) {
          crlTaken = true;
          now += o.takes?.crl ?? 0;
        }
        return res;
      },
      clock: () => now,
      store,
      card,
      prover,
      startTreeBuilder: async () => ({
        build: (k, n, s) =>
          buildWith([p.runner(), p.runner()], k, n, s).then((r) => {
            now += o.takes?.tree ?? 0;
            return r;
          }),
        close: () => undefined,
      }),
      onBackgroundStop: onStop,
      onIdle: (s) => idleStops.push(s),
      onProgress: (p) => progress.push(p),
      counts,
      setTimer: (ms, f) => {
        const t = { at: now + ms, f, done: false };
        timers.push(t);
        return () => (t.done = true);
      },
    },
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
  return { w, backend, data, card, flow, store, backgroundStop, proveCalls, advance, fireTimers, idleStops, progress, prover, hold, counted, counts, idStorage, beforeCrl: () => beforeCrl };
}

/** A slot of the card-state answer (docs/api/card-proof.md): empty unless the test says otherwise. */
type SlotJson = { current?: unknown; last_declared?: unknown; switch_count?: unknown };
const slot = (o: SlotJson = {}): Record<string, unknown> => ({ current: null, last_declared: null, switch_count: 0, ...o });
/** A slot declared to `u`. */
const has = (u: string, o: SlotJson = {}): Record<string, unknown> => slot({ current: u, last_declared: u, ...o });

/**
 * A card-state answer: the test log's two platforms, empty unless
 * `platforms` says otherwise; one record on the last card proof's date and a
 * daily limit of 3 unless the test says otherwise. Any other key is added as
 * it is.
 */
function cardState(o: { last_card_proof?: string | null; proofs_on_last_date?: unknown; daily_limit?: unknown; platforms?: Record<string, unknown>; [k: string]: unknown } = {}): Record<string, unknown> {
  const { last_card_proof = null, platforms = {}, proofs_on_last_date: _p, daily_limit: _d, ...rest } = o;
  return {
    last_card_proof,
    proofs_on_last_date: "proofs_on_last_date" in o ? o.proofs_on_last_date : last_card_proof ? 1 : 0,
    daily_limit: "daily_limit" in o ? o.daily_limit : 3,
    platforms: { "test-example": slot(), threads: slot(), ...platforms },
    count: 137,
    ...rest,
  };
}

/** A card that declares @alice on Threads since 2026-03-02, one switch, last card proof 2026-11-04. */
const DECLARED = cardState({ last_card_proof: "2026-11-04", platforms: { threads: has("alice", { switch_count: 1 }) } });

/**
 * The entries the screen hands choose(): every platform offered, with the
 * account it holds now unless `changes` says otherwise ("" for none).
 */
function listOf(status: CardStatus, changes: Record<string, string> = {}): Choice {
  return Object.fromEntries(status.slots.filter((s) => s.row !== null).map((s) => [s.platform, s.platform in changes ? changes[s.platform]! : (s.current ?? "")]));
}

/** Card read, PIN given, the card's state known. */
async function toStatus(s: Setup): Promise<CardStatus> {
  await s.flow.readCard();
  return s.flow.confirmCard(PIN);
}

/** Card read, PIN given, the card's state known, the list changed by `changes` (by default @alice on Threads). */
async function toChosen(s: Setup, changes: Record<string, string> = { threads: "alice" }): Promise<Consequence> {
  return s.flow.choose(listOf(await toStatus(s), changes));
}

/**
 * toChosen(), with the PIN given HELD_CHALLENGE_MS after the checks that need
 * no signature passed: the challenge asked for while the card was read is too
 * old by then, and proceed() asks for one of its own.
 */
async function toChosenAsking(s: Setup, changes: Record<string, string> = { threads: "alice" }): Promise<Consequence> {
  await s.flow.readCard();
  await s.flow.checksDone();
  s.advance(HELD_CHALLENGE_MS);
  return s.flow.choose(listOf(await s.flow.confirmCard(PIN), changes));
}

/** choose() with the card's state the flow holds, changed by `changes`. */
const pick = (s: Setup, changes: Record<string, string> = {}): Consequence => s.flow.choose(listOf(s.flow.cardStatus!, changes));

/** The FlowStop choose() throws, or null. */
function refused(f: () => unknown): Stop | null {
  try {
    f();
  } catch (e) {
    if (e instanceof FlowStop) return e.stop;
    throw e;
  }
  return null;
}

/** The rows of a consequence, in short. */
const rowsOf = (cq: Consequence) => cq.rows.map((r) => [r.platform, r.kind, r.username, r.current, r.previous, r.switchesLeftAfter]);

/** The flow's PIN, for tests only (it is private). */
const heldPin = (f: CardProofFlow): unknown => (f as unknown as { pin: unknown }).pin;

async function stopOf(p: Promise<unknown>): Promise<Stop> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FlowStop) return e.stop;
    throw e;
  }
  assert.fail("did not stop");
}

/**
 * No request after the stop, none submitted a record, and none carries the
 * reason but one count: a `stop` with the code of the table for it, which
 * holds nothing else of the stop.
 */
async function assertQuiet(s: Setup, stop: Stop, requestsAtStop: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  assertCounts(s);
  const told = (event: string): unknown[] => s.counted.filter((c) => c.event === event).map((c) => c.reason);
  // A stop that ended the flow is one `stop`; one that leaves the step to be tried again is a `retry`, and no `stop`.
  if (s.flow.stop !== null || s.counted.some((c) => c.event === "stop")) assert.deepEqual(told("stop"), [reasonOf(stop)], "one count says why it stopped");
  else assert.equal(told("retry").at(-1), reasonOf(stop), "a count says why the step must be tried again");
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

/**
 * Every count the page sent is one the table takes (spec/counts.md), from
 * the web page, with the browser's and the system's names and no version;
 * its members are the table's and nothing else.
 */
function assertCounts(s: Setup): void {
  for (const c of s.counted) {
    assert.deepEqual(readCount(c), c, `a count the table does not take, or not in its order: ${JSON.stringify(c)}`);
    assert.deepEqual([c.client, c.browser, c.os, c.browser_version, c.os_version], ["web", "chrome", "windows", "131", "10.0"]);
    assert.deepEqual(Object.keys(c).filter((k) => !["client", "event", "step", "reason", "action", "took", "device_id", "attempt_id", "browser", "os", "browser_version", "os_version", "reader"].includes(k)), []);
  }
}

/** No request carried the scoped ID. */
function assertNoCardState(s: Setup): void {
  assert.equal(s.backend.log.filter((r) => r.path === "/api/v1/card-state").length, 0, "a card-state request was sent");
}

/** Card read, then the background (config, CRL, tree, circuit) finishes or stops. */
async function readAndWait(s: Setup): Promise<Stop | null> {
  await s.flow.readCard();
  const quiet = new Promise<null>((r) => setTimeout(() => r(null), 3000));
  return Promise.race([s.backgroundStop, quiet]);
}

const MALFORMED: Stop = { code: "server", server: "malformed_response", status: 200 };

describe("the maintainer stopped taking card proofs (config's paused, #105)", () => {
  const THREADS_ROW = { platform: "threads", display_name: "Threads", username_format: "[a-z0-9._]{1,30}" };
  test("config says paused while the card is read: stopped before the PIN, under the server's item; nothing signed, no card-state", async () => {
    const s = await setup({ backend: { config: { paused: true, crl_max_age_days: 3, platforms: [THREADS_ROW] } } });
    assert.deepEqual(await readAndWait(s), { code: "server", server: "paused", status: 200 });
    assert.equal(s.card.signed.length, 0);
    assertNoCardState(s);
  });
  test("the challenge answered 503 paused (stopped after the card's state was read): stopped under the server, nothing signed a second time", async () => {
    const s = await setup({ echoPublicInputs: true, backend: { challenge: () => ({ status: 503, body: { error: "paused" } }) } });
    const cq = await toChosen(s);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "paused", status: 503 });
    assert.notEqual(s.flow.stop, null, "paused ends the flow");
    assert.equal(s.card.signed.length, 1, "no second signature");
  });

  test("config says not paused, or says nothing of it (an older server): the card proof goes on", async () => {
    for (const config of [{ paused: false, crl_max_age_days: 3, platforms: [THREADS_ROW] }, { crl_max_age_days: 3, platforms: [THREADS_ROW] }]) {
      const s = await setup({ backend: { config } });
      assert.equal(await readAndWait(s), null, JSON.stringify(config));
    }
  });
});

describe("the flow, with a server that gives values the device must not accept", async () => {
  test("a challenge not dated today", async () => {
    const s = await setup({ backend: { challenge: () => "2026-11-15.000G40R40M30E209185GR38E1W" } });
    const cq = await toChosen(s);
    const stop = await stopOf(s.flow.proceed(cq.accounts));
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
      const cq = await toChosen(s);
      const stop = await stopOf(s.flow.proceed(cq.accounts));
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

  // The platform table: without one the device can read, it has nothing to offer and nothing to check an account against.
  const row = (platform: string, username_format: string, display_name = platform) => ({ platform, display_name, username_format });
  for (const [name, config] of [
    ["config without a platform table", { crl_max_age_days: 3 }],
    ["a platform table that is not a list", { crl_max_age_days: 3, platforms: { threads: row("threads", "[a-z0-9._]{1,30}") } }],
    ["an empty platform table", { crl_max_age_days: 3, platforms: [] }],
    ["no row the device can read (a format not in the one form)", { crl_max_age_days: 3, platforms: [row("test-example", "[a-z0-9-]+"), row("threads", "^[a-z0-9._]+$")] }],
    ["rows out of order", { crl_max_age_days: 3, platforms: [row("threads", "[a-z0-9._]{1,30}"), row("test-example", "[a-z0-9-]{1,20}")] }],
    ["one platform twice", { crl_max_age_days: 3, platforms: [row("threads", "[a-z0-9._]{1,30}"), row("threads", "[a-z]{1,5}")] }],
    ["a row naming a platform twice, one of them unreadable", { crl_max_age_days: 3, platforms: [row("threads", "[a-z]+"), row("threads", "[a-z0-9._]{1,30}")] }],
    ["no CRL age bound", { platforms: [row("threads", "[a-z0-9._]{1,30}")] }],
  ] as const) {
    await crlCase(`${name}: not read, before the PIN`, { backend: { config } }, MALFORMED);
  }

  for (const [name, o, expected] of [
    ["serial on the CRL", { crls: [{ serials: [...randomSerials(50), 0x1234567890abcdef1234567890abcdefn], crlNumber: 100n, thisUpdate: CRL_TIME }] }, { code: "revoked" }],
    ["CRL not usable", { crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: CRL_TIME, extraExtensions: [IDP] }] }, { code: "revocation", problem: { code: "crl_unusable", reason: "not_usable_partitioned" } }],
    ["circuit hash wrong", { tamperCircuit: true }, { code: "artifact", path: "/circuits/card_proof_rs4096.json" }],
    ["platform table unreadable", { backend: { platforms: [] } }, MALFORMED],
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

  test("the second signature needs the list the screen showed", async () => {
    const s = await setup({ backend: { cardState: DECLARED } });
    const cq = await toChosen(s, { "test-example": "a-b" });
    assert.deepEqual(cq.accounts, [
      { platform: "test-example", username: "a-b" },
      { platform: "threads", username: "alice" },
    ]);
    const n = s.backend.log.length;
    for (const other of [
      [{ platform: "threads", username: "alice" }],
      [{ platform: "test-example", username: "a-b" }, { platform: "threads", username: "bob" }],
      [{ platform: "threads", username: "alice" }, { platform: "test-example", username: "a-b" }],
      [...cq.accounts, { platform: "x-new", username: "zed" }],
    ]) {
      const t = await setup({ backend: { cardState: DECLARED } });
      await toChosen(t, { "test-example": "a-b" });
      assert.deepEqual(await stopOf(t.flow.proceed(other)), { code: "state" }, JSON.stringify(other));
      assert.equal(t.card.signed.length, 1, "no second signature");
      assert.equal(requestsOn(t, "/api/v1/challenges"), 1, "no challenge requested but the reading's");
    }
    assert.equal(s.backend.log.length, n);
  });

  test("a submission the server refuses for good, and one that can be sent again", async () => {
    let answer = { status: 503, body: { error: "crl_stale" } as unknown };
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    const cq = await toChosen(s);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "crl_stale", status: 503 });
    assert.notEqual(s.flow.stop, null, "crl_stale ends the flow");

    // The server takes no card proof until the maintainer resumes (#105, #131): not "submit_failed", no 再試一次.
    answer = { status: 503, body: { error: "paused" } };
    const p = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    const cqp = await toChosen(p);
    assert.deepEqual(await stopOf(p.flow.proceed(cqp.accounts)), { code: "server", server: "paused", status: 503 });
    assert.notEqual(p.flow.stop, null, "paused ends the flow");
    assert.notEqual(p.flow.phase, "submit_failed");

    answer = { status: 500, body: { error: "internal" } };
    const t = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    const cq2 = await toChosen(t);
    assert.deepEqual(await stopOf(t.flow.proceed(cq2.accounts)), { code: "server", server: "internal", status: 500 });
    assert.equal(t.flow.stop, null, "internal can be sent again");
    answer = { status: 201, body: { seq: 7, record_hash: "b".repeat(64), kinds: [{ platform: "threads", kind: "first", username: "alice", account_cards: 1 }] } };
    const done = await t.flow.resubmit();
    assert.equal(done.seq, 7);
    assert.equal(t.backend.submissions.length, 2);
    assert.equal(JSON.stringify(t.backend.submissions[0]), JSON.stringify(t.backend.submissions[1]), "the same record");
    assert.equal(t.card.signed.length, 2, "no new signature");
  });

  test("a file served under its name but with other bytes", async () => {
    const s = await setup();
    const sha = [...s.data.opts.files.keys()].find((k) => k.endsWith(".crl"))!;
    const bytes = s.data.opts.files.get(sha)!.slice();
    bytes[bytes.length - 1]! ^= 1;
    s.data.opts.files.set(sha, bytes);
    const bg = await readAndWait(s);
    assert.deepEqual(bg, { code: "revocation", problem: { code: "crl_hash" } });
  });

  test("the CRL comes from the data domain: its index, then one file; the server is not asked for it", async () => {
    const s = await setup();
    assert.equal(await readAndWait(s), null);
    const sha = [...s.data.opts.files.keys()].find((k) => k.endsWith(".crl"))!;
    assert.deepEqual(
      s.data.log.map((r) => `${r.method} ${r.path}`),
      ["GET /crl/index.jsonl", `GET ${sha}`],
    );
    assert.deepEqual(s.backend.log.filter((r) => r.path.startsWith("/crl/")), []);
  });

  test("a usable CRL: its number is remembered, nothing else is stored", async () => {
    const s = await setup({ remembered: { G3: 99n } });
    assert.equal(await readAndWait(s), null);
    assert.deepEqual(s.store.values, { G3: 100n });
  });

  test("the card signs the public proof log's scope string; neither config nor the card's state can change it", async () => {
    const s = await setup({
      backend: {
        config: { crl_max_age_days: 3, platforms: [{ platform: "threads", display_name: "Threads", username_format: "[a-z0-9._]{1,30}", scope_string: "iamreal:threads:0______________" }], scope_string: "iamreal:public:0_______________" },
        cardState: { ...cardState({ last_card_proof: "2026-11-04", platforms: { threads: has("bob") } }), scope_string: "iamreal:public:0_______________" },
      },
    });
    await toStatus(s);
    assert.equal(new TextDecoder().decode(s.card.signed[0]), SCOPE);
    assert.equal(s.flow.scopeString, SCOPE);
    const req = s.backend.log.find((r) => r.path === "/api/v1/card-state")!;
    assert.equal(req.method, "POST");
    assert.deepEqual(Object.keys(JSON.parse(req.body)), ["scope_string", "scoped_id"]);
    assert.equal(JSON.parse(req.body).scope_string, SCOPE);
  });
});

describe("the card's list: what the device makes of the card's state", () => {
  test("never declared: one slot per platform of the table, nothing in the list", async () => {
    const s = await setup();
    const st = await toStatus(s);
    assert.equal(st.lastCardProof, null);
    assert.deepEqual(st.accounts, []);
    assert.deepEqual(
      st.slots.map((x) => [x.platform, x.row?.displayName, x.current, x.lastDeclared, x.switchCount, x.switchesLeft]),
      [
        ["test-example", "Example (no real service)", null, null, 0, 5],
        ["threads", "Threads", null, null, 0, 5],
      ],
    );
    assert.equal(st.dailyLimit, false);
    assert.equal(st.today, "2026-11-16");
    assert.equal(st.shortId.length, 10);
    assert.equal(st.shortId, st.scopedId.slice(0, 10));
  });

  test("the counts of each slot: switches left by the rules", async () => {
    const s = await setup({
      backend: { cardState: cardState({ last_card_proof: "2026-11-16", platforms: { "test-example": has("a-b", { switch_count: 4 }), threads: has("alice", { switch_count: 2 }) } }) },
    });
    const st = await toStatus(s);
    assert.deepEqual(
      st.slots.map((x) => [x.platform, x.switchCount, x.switchesLeft]),
      [
        ["test-example", 4, 1],
        ["threads", 2, 3],
      ],
    );
    assert.deepEqual(st.accounts, [
      { platform: "test-example", username: "a-b" },
      { platform: "threads", username: "alice" },
    ]);
  });

  test("a platform of the table the card's state has no entry for: not offered", async () => {
    const st = cardState({ last_card_proof: "2026-11-04", platforms: { threads: has("alice") } });
    delete (st.platforms as Record<string, unknown>)["test-example"];
    const s = await setup({ backend: { cardState: st } });
    const status = await toStatus(s);
    assert.deepEqual(status.slots.map((x) => x.platform), ["threads"]);
    // Naming it is out of order.
    assert.deepEqual(refused(() => s.flow.choose({ "test-example": "a-b", threads: "alice" })), { code: "state" });
    assert.deepEqual(pick(s).accounts, [{ platform: "threads", username: "alice" }]);
  });

  test("a platform the device does not know, with an account: kept as it is, in byte order, signed and sent", async () => {
    const st = cardState({
      last_card_proof: "2026-11-04",
      platforms: { threads: has("alice"), "x-new": { current: "Zed Z~", whatever: 1 }, "aaa-new": slot({ current: "yy", last_declared: "yy" }), "b-gone": { current: null } },
    });
    const s = await setup({ echoPublicInputs: true, backend: { cardState: st, submit: () => ({ status: 201, body: { seq: 3, record_hash: "c".repeat(64), kinds: [] } }) } });
    const status = await toStatus(s);
    assert.deepEqual(
      status.slots.map((x) => [x.platform, x.row === null, x.current]),
      [
        ["aaa-new", true, "yy"],
        ["test-example", false, null],
        ["threads", false, "alice"],
        ["x-new", true, "Zed Z~"],
      ],
    );
    // Only the platforms of the table are the caller's to fill.
    assert.deepEqual(Object.keys(listOf(status)), ["test-example", "threads"]);
    assert.deepEqual(refused(() => s.flow.choose({ ...listOf(status), "x-new": "" })), { code: "state" });
    const cq = pick(s, { "test-example": "a-b" });
    const list = [
      { platform: "aaa-new", username: "yy" },
      { platform: "test-example", username: "a-b" },
      { platform: "threads", username: "alice" },
      { platform: "x-new", username: "Zed Z~" },
    ];
    assert.deepEqual(cq.accounts, list);
    assert.deepEqual(rowsOf(cq), [
      ["aaa-new", "refresh", "yy", "yy", null, null],
      ["test-example", "first", "a-b", null, null, null],
      ["threads", "refresh", "alice", "alice", null, null],
      ["x-new", "refresh", "Zed Z~", "Zed Z~", null, null],
    ]);
    // Even emptying every row of the table keeps them.
    assert.deepEqual(pick(s, { threads: "" }).accounts.map((a) => a.platform), ["aaa-new", "x-new"]);
    const done = await s.flow.proceed(pick(s, { "test-example": "a-b" }).accounts);
    const sub = s.backend.submissions[0]!;
    assert.deepEqual(sub.accounts, list);
    const code = await declarationCode(SCOPE, list, sub.challenge as string);
    assert.deepEqual(s.card.signed[1], code, "the card signed the code of the whole list");
    assert.equal(done.kinds, null, "kinds [] cannot be read");
  });

  test("a format not in the one form: that platform is one the device does not know", async () => {
    const config = {
      crl_max_age_days: 3,
      platforms: [
        { platform: "test-example", display_name: "Example (no real service)", username_format: "[a-z0-9-]{1,20}" },
        { platform: "threads", display_name: "Threads", username_format: "^[a-z0-9._]{1,30}$" },
        { platform: "u-new", display_name: "Bad\u0007name", username_format: "[a-z]{1,5}" },
      ],
    };
    const s = await setup({ echoPublicInputs: true, backend: { config, cardState: cardState({ last_card_proof: "2026-11-04", platforms: { threads: has("alice"), "u-new": { current: null } } }) } });
    const status = await toStatus(s);
    assert.deepEqual(status.slots.map((x) => [x.platform, x.row === null]), [["test-example", false], ["threads", true]]);
    const cq = pick(s, { "test-example": "a-b" });
    assert.deepEqual(cq.accounts, [
      { platform: "test-example", username: "a-b" },
      { platform: "threads", username: "alice" },
    ]);
    await s.flow.proceed(cq.accounts);
    assert.deepEqual(s.backend.submissions[0]!.accounts, cq.accounts);
  });

  test("the kinds of each platform: first, refresh, switch, withdraw", async () => {
    const never = await setup();
    await toStatus(never);
    const n = pick(never, { "test-example": "a-b", threads: "alice" });
    assert.equal(n.firstRecord, true);
    assert.equal(n.today, "2026-11-16");
    assert.deepEqual(rowsOf(n), [
      ["test-example", "first", "a-b", null, null, null],
      ["threads", "first", "alice", null, null, null],
    ]);

    const d = await setup({ backend: { cardState: DECLARED } });
    await toStatus(d);
    const same = pick(d);
    assert.equal(same.firstRecord, false);
    assert.deepEqual(rowsOf(same), [["threads", "refresh", "alice", "alice", null, null]]);
    assert.deepEqual(rowsOf(pick(d, { threads: "bob" })), [["threads", "switch", "bob", "alice", "alice", 3]]);
    const w = pick(d, { threads: "" });
    assert.deepEqual(w.accounts, []);
    assert.deepEqual(rowsOf(w), [["threads", "withdraw", "alice", "alice", null, null]]);
    assert.deepEqual(rowsOf(pick(d, { "test-example": "a-b" })), [
      ["test-example", "first", "a-b", null, null, null],
      ["threads", "refresh", "alice", "alice", null, null],
    ]);

    // Withdrawn: the same account again is a refresh; another one a switch from the one withdrawn.
    const withdrawn = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-10", platforms: { threads: slot({ last_declared: "bob" }) } }) } });
    const ws = await toStatus(withdrawn);
    assert.deepEqual(ws.accounts, []);
    assert.deepEqual(rowsOf(pick(withdrawn, { threads: "bob" })), [["threads", "refresh", "bob", null, null, null]]);
    assert.deepEqual(rowsOf(pick(withdrawn, { threads: "carol" })), [["threads", "switch", "carol", null, "bob", 4]]);
  });

  test("a change on the day the account was put there: a switch like any other (ADR-0018)", async () => {
    for (const count of [0, 3]) {
      const s = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-16", platforms: { threads: has("alice", { switch_count: count }) } }) } });
      await toStatus(s);
      assert.deepEqual(rowsOf(pick(s, { threads: "bob" })), [["threads", "switch", "bob", "alice", "alice", 4 - count]], `count ${count}`);
    }
    const none = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-16", platforms: { threads: has("alice", { switch_count: 5 }) } }) } });
    await toStatus(none);
    assert.deepEqual(refused(() => pick(none, { threads: "bob" })), { code: "blocked", reason: "switch_limit", platform: "threads" });
    // Withdrawn on the day it was put there: another account is a switch too.
    const w = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-16", proofs_on_last_date: 2, platforms: { threads: slot({ last_declared: "alice" }) } }) } });
    await toStatus(w);
    assert.deepEqual(rowsOf(pick(w, { threads: "bob" })), [["threads", "switch", "bob", null, "alice", 4]]);
  });

  test("the switches: 5 by the rules, on the web too; a blocked platform blocks the list, the cardholder can change it", async () => {
    // The fourth and the fifth are made on the web like the first three.
    for (const count of [3, 4]) {
      const s = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-04", platforms: { threads: has("alice", { switch_count: count }) } }) } });
      await toStatus(s);
      assert.deepEqual(rowsOf(pick(s, { threads: "bob" })), [["threads", "switch", "bob", "alice", "alice", 4 - count]], `count ${count}`);
    }
    for (const [count, reason] of [[5, "switch_limit"]] as const) {
      const s = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-04", platforms: { threads: has("alice", { switch_count: count }) } }) } });
      await toStatus(s);
      const n = s.backend.log.length;
      const stop = refused(() => pick(s, { threads: "bob", "test-example": "a-b" }));
      assert.deepEqual(stop, { code: "blocked", reason, platform: "threads" }, `count ${count}`);
      assert.equal(s.flow.stop, null, "the cardholder can change the list again");
      assert.equal(s.flow.phase, "status_known");
      // Nothing was picked: there is nothing to sign.
      assert.deepEqual(await stopOf(s.flow.proceed([])), { code: "state" });
      // Leaving the platform alone, or emptying it, is not a switch.
      assert.deepEqual(rowsOf(pick(s, { "test-example": "a-b" })).map((r) => r[1]), ["first", "refresh"]);
      assert.deepEqual(rowsOf(pick(s, { threads: "" })).map((r) => r[1]), ["withdraw"]);
      assert.equal(s.card.signed.length, 1);
      await assertQuiet(s, stop!, n);
    }
    // The sixth switch after a withdrawal is refused the same way.
    const w = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-04", platforms: { threads: slot({ last_declared: "alice", switch_count: 5 }) } }) } });
    await toStatus(w);
    assert.deepEqual(refused(() => pick(w, { threads: "bob" })), { code: "blocked", reason: "switch_limit", platform: "threads" });
    assert.deepEqual(rowsOf(pick(w, { threads: "alice" })).map((r) => r[1]), ["refresh"]);
  });

  test("an empty list for a card that declares nothing: refused (empty), the cardholder can fill a row", async () => {
    for (const state of [undefined, cardState({ last_card_proof: "2026-11-10", platforms: { threads: slot({ last_declared: "bob" }) } })]) {
      const s = await setup({ backend: { ...(state && { cardState: state }) } });
      await toStatus(s);
      const n = s.backend.log.length;
      const stop = refused(() => pick(s, {}));
      assert.deepEqual(stop, { code: "blocked", reason: "empty" });
      assert.equal(s.flow.stop, null);
      assert.equal(pick(s, { threads: "bob" }).accounts.length, 1);
      await assertQuiet(s, stop!, n);
    }
  });

  test("3 records today: the engine refuses every list; no second signature, no challenge", async () => {
    const s = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-16", proofs_on_last_date: 3, platforms: { threads: has("alice") } }) } });
    const status = await toStatus(s);
    assert.equal(status.dailyLimit, true);
    const n = s.backend.log.length;
    for (const changes of [{}, { threads: "bob" }, { threads: "" }, { "test-example": "a-b" }] as Record<string, string>[]) {
      assert.deepEqual(refused(() => pick(s, changes)), { code: "blocked", reason: "daily_limit" }, JSON.stringify(changes));
    }
    assert.equal(s.flow.stop, null, "the screen goes back to the beginning; the engine does not end the flow by itself");
    assert.equal(s.flow.phase, "status_known");
    assert.deepEqual(await stopOf(s.flow.proceed(status.accounts)), { code: "state" });
    assert.equal(s.card.signed.length, 1);
    await assertQuiet(s, { code: "blocked", reason: "daily_limit" }, n);
  });

  test("3 records today and the switches used up: the switch is refused for the switch limit first, as the rules order them", async () => {
    const s = await setup({ backend: { cardState: cardState({ last_card_proof: "2026-11-16", proofs_on_last_date: 3, platforms: { threads: has("bob", { switch_count: 5 }) } }) } });
    await toStatus(s);
    assert.deepEqual(refused(() => pick(s, { threads: "alice" })), { code: "blocked", reason: "switch_limit", platform: "threads" });
    assert.deepEqual(refused(() => pick(s, {})), { code: "blocked", reason: "daily_limit" });
  });

  test("fewer than 3 records today, or 3 on another date: every list as before", async () => {
    for (const [date, n] of [["2026-11-16", 2], ["2026-11-15", 3], ["2026-11-17", 3]] as const) {
      const s = await setup({ backend: { cardState: cardState({ last_card_proof: date, proofs_on_last_date: n, platforms: { threads: has("alice") } }) } });
      const status = await toStatus(s);
      assert.equal(status.dailyLimit, false, `${n} on ${date}`);
      assert.equal(pick(s).rows[0]!.kind, "refresh");
      assert.equal(pick(s, { threads: "" }).rows[0]!.kind, "withdraw");
    }
  });

  test("the server rejects the card proof as the fourth of today (daily_limit): the flow ends", async () => {
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => ({ status: 400, body: { error: "daily_limit" } }) } });
    const cq = await toChosen(s);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "daily_limit", status: 400 });
    assert.notEqual(s.flow.stop, null);
    assert.equal(s.flow.phase, "stopped");
    assert.equal(s.backend.submissions.length, 1);
  });

  test("an account not in its platform's format: refused, under that platform; the cardholder can type again", async () => {
    const s = await setup();
    await toStatus(s);
    for (const [platform, bad] of [["threads", "Alice"], ["threads", "a".repeat(31)], ["threads", "al ice"], ["threads", "a-b"], ["test-example", "a.b"], ["test-example", "A"], ["test-example", "a".repeat(21)]]) {
      assert.deepEqual(refused(() => pick(s, { [platform!]: bad! })), { code: "username", platform }, `${platform} ${bad}`);
    }
    assert.equal(s.flow.stop, null);
    assert.deepEqual(rowsOf(pick(s, { threads: "a.b", "test-example": "a-b" })).map((r) => r[1]), ["first", "first"]);
  });

  test("entries that are not one per platform offered: out of order", async () => {
    const s = await setup();
    await toStatus(s);
    for (const bad of [{ threads: "alice" }, { threads: "alice", "test-example": "", other: "" }, { threads: "alice", "test-example": null as unknown as string }] as Record<string, string>[]) {
      assert.deepEqual(refused(() => s.flow.choose(bad)), { code: "state" }, JSON.stringify(bad));
    }
    assert.equal(s.flow.stop, null);
  });

  test("back and forth between the card's list and the consequence: nothing signed or asked again", async () => {
    const s = await setup({ echoPublicInputs: true, backend: { cardState: DECLARED } });
    await toChosen(s, { threads: "bob" });
    const requests = s.backend.log.length;
    assert.deepEqual(s.flow.back().accounts, [{ platform: "threads", username: "alice" }]);
    assert.equal(s.flow.phase, "status_known");
    assert.equal(pick(s, { threads: "" }).rows[0]!.kind, "withdraw");
    s.flow.back();
    const last = pick(s, { "test-example": "a-b" });
    assert.equal(s.card.signed.length, 1, "one signature so far");
    assert.equal(s.backend.log.length, requests, "no request while picking");
    // The record is the last list.
    await s.flow.proceed(last.accounts);
    const sub = s.backend.submissions[0]!;
    assert.deepEqual(sub.accounts, [
      { platform: "test-example", username: "a-b" },
      { platform: "threads", username: "alice" },
    ]);
    assert.equal(s.card.signed.length, 2);
    assert.equal(s.backend.log.filter((r) => r.path === "/api/v1/card-state").length, 1);
  });
});

describe("the submission and what the server says it recorded", () => {
  test("the request: the record's fields in their order, the whole list in byte order, no action or account of its own", async () => {
    const s = await setup({ echoPublicInputs: true });
    await toStatus(s);
    const cq = pick(s, { threads: "alice", "test-example": "a-b" });
    const done = await s.flow.proceed(cq.accounts);
    const raw = s.backend.log.find((r) => r.path === "/api/v1/records")!.body;
    const sub = JSON.parse(raw) as Record<string, unknown>;
    // After the record's fields, the card proof device ID (ADR-0039), which is no part of the record.
    assert.deepEqual(Object.keys(sub), ["scope_string", "scoped_id", "accounts", "challenge", "issuer", "smt_root", "circuit", "proof", "device_id"]);
    assert.equal(sub.device_id, s.counts.deviceId());
    assert.equal(sub.scope_string, SCOPE);
    assert.ok(raw.includes('"accounts":[{"platform":"test-example","username":"a-b"},{"platform":"threads","username":"alice"}]'), raw.slice(0, 300));
    const code = await declarationCode(SCOPE, cq.accounts, sub.challenge as string);
    assert.deepEqual(s.card.signed[1], code);
    // The fake server's own proof log answers as the rules do: what step 5 showed.
    assert.deepEqual(done.kinds, [
      { platform: "test-example", kind: "first", username: "a-b", accountCards: 1 },
      { platform: "threads", kind: "first", username: "alice", accountCards: 1 },
    ]);
    assert.deepEqual(done.mismatches, []);
    assert.equal(done.firstRecord, true);
    assert.deepEqual(done.accounts, cq.accounts);
    assert.deepEqual(done.expected, cq.rows);
    assert.equal(done.date, "2026-11-16");
    assert.equal(done.shortId, done.scopedId.slice(0, 10));
  });

  test("an empty list (withdraw everything): the request carries accounts []", async () => {
    const s = await setup({ echoPublicInputs: true, backend: { cardState: DECLARED, submit: () => ({ status: 201, body: { seq: 4, record_hash: "c".repeat(64), kinds: [{ platform: "threads", kind: "withdraw", username: "alice", account_cards: 0 }] } }) } });
    const cq = await toChosen(s, { threads: "" });
    const done = await s.flow.proceed(cq.accounts);
    assert.ok(s.backend.log.find((r) => r.path === "/api/v1/records")!.body.includes('"accounts":[]'));
    assert.deepEqual([done.mismatches, done.accounts, done.kinds![0]!.accountCards], [[], [], 0]);
  });

  const kindsAnswer = (kinds: unknown) => ({ status: 201, body: { seq: 9, record_hash: "c".repeat(64), kinds } });

  test("kinds passed on to the screen, with account_cards", async () => {
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => kindsAnswer([{ platform: "threads", kind: "first", username: "alice", account_cards: 3 }]) } });
    const cq = await toChosen(s);
    const done = await s.flow.proceed(cq.accounts);
    assert.deepEqual([done.seq, done.recordHash, done.kinds], [9, "c".repeat(64), [{ platform: "threads", kind: "first", username: "alice", accountCards: 3 }]]);
  });

  // The record is in the proof log already: kinds the device cannot read do not stop the card proof.
  for (const [label, kinds] of [
    ["no kinds", "(none)"],
    ["not a list", { threads: "first" }],
    ["an empty list", []],
    ["a kind it does not know", [{ platform: "threads", kind: "declare", username: "alice", account_cards: 1 }]],
    ["no username", [{ platform: "threads", kind: "first", account_cards: 1 }]],
    ["a platform not an ID", [{ platform: "Threads", kind: "first", username: "alice", account_cards: 1 }]],
    ["out of order", [{ platform: "threads", kind: "first", username: "alice" }, { platform: "test-example", kind: "first", username: "a-b" }]],
    ["one platform twice", [{ platform: "threads", kind: "first", username: "alice" }, { platform: "threads", kind: "first", username: "alice" }]],
    ["an element not an object", ["threads"]],
  ] as const) {
    test(`kinds not read (${label}): done, what was recorded not known, no mismatch claimed`, async () => {
      const body: Record<string, unknown> = { seq: 9, record_hash: "c".repeat(64) };
      if (kinds !== "(none)") body.kinds = kinds;
      const s = await setup({ echoPublicInputs: true, backend: { submit: () => ({ status: 201, body }) } });
      const cq = await toChosen(s);
      const done = await s.flow.proceed(cq.accounts);
      assert.deepEqual([done.seq, done.recordHash, done.kinds, done.mismatches], [9, "c".repeat(64), null, []]);
      assert.equal(s.flow.phase, "done");
    });
  }

  for (const bad of ["(none)", -1, 1.5, "1", null]) {
    test(`account_cards not a count (${JSON.stringify(bad)}): that element's number not known, the rest read`, async () => {
      const el: Record<string, unknown> = { platform: "threads", kind: "first", username: "alice" };
      if (bad !== "(none)") el.account_cards = bad;
      const s = await setup({ echoPublicInputs: true, backend: { submit: () => kindsAnswer([{ platform: "test-example", kind: "first", username: "a-b", account_cards: 2 }, el]) } });
      await toStatus(s);
      const done = await s.flow.proceed(pick(s, { threads: "alice", "test-example": "a-b" }).accounts);
      assert.deepEqual(done.kinds, [
        { platform: "test-example", kind: "first", username: "a-b", accountCards: 2 },
        { platform: "threads", kind: "first", username: "alice", accountCards: null },
      ]);
      assert.deepEqual(done.mismatches, []);
    });
  }

  // seq and record_hash stay strict.
  for (const [label, body] of [
    ["no seq", { record_hash: "c".repeat(64), kinds: [{ platform: "threads", kind: "first", username: "alice", account_cards: 1 }] }],
    ["a record_hash not in hex", { seq: 9, record_hash: "C".repeat(64), kinds: [{ platform: "threads", kind: "first", username: "alice", account_cards: 1 }] }],
  ] as const) {
    test(`${label}: a 201 is a record made; nothing of the answer is told`, async () => {
      const s = await setup({ echoPublicInputs: true, backend: { submit: () => ({ status: 201, body }) } });
      const cq = await toChosen(s);
      const done = await s.flow.proceed(cq.accounts);
      assert.deepEqual([done.seq, done.recordHash, done.kinds, done.mismatches], [null, null, null, []]);
      assert.equal(s.flow.phase, "done");
    });
  }
  for (const [label, body] of [
    ["not JSON", "<html>"],
    ["a list", "[]"],
    ["empty", ""],
  ] as const) {
    test(`a 201 whose body is ${label}: done, the record made, nothing of the answer told`, async () => {
      const s = await setup({ echoPublicInputs: true });
      const orig = s.backend.fetch;
      s.backend.fetch = (async (path: string, init?: { method: "GET" | "POST"; body?: string }) =>
        path === "/api/v1/records" ? new Response(body, { status: 201, headers: { "Content-Type": "application/json" } }) : orig(path, init)) as typeof s.backend.fetch;
      const cq = await toChosen(s);
      const done = await s.flow.proceed(cq.accounts);
      assert.deepEqual([done.seq, done.recordHash, done.kinds], [null, null, null]);
    });
  }

  test("what the server recorded differs from what step 5 said: the platforms where it does", async () => {
    // The card declares a-b and alice; the cardholder changes Threads' account: a switch.
    const state = cardState({ last_card_proof: "2026-11-16", platforms: { "test-example": has("a-b"), threads: has("alice") } });
    const cases: [string, unknown[], string[]][] = [
      ["as shown", [{ platform: "test-example", kind: "refresh", username: "a-b" }, { platform: "threads", kind: "switch", username: "bob" }], []],
      ["a refresh, not the switch shown", [{ platform: "test-example", kind: "refresh", username: "a-b" }, { platform: "threads", kind: "refresh", username: "bob" }], ["threads"]],
      ["another account", [{ platform: "test-example", kind: "refresh", username: "a-b" }, { platform: "threads", kind: "switch", username: "carol" }], ["threads"]],
      ["a platform missing", [{ platform: "threads", kind: "switch", username: "bob" }], ["test-example"]],
      ["a platform more", [{ platform: "test-example", kind: "refresh", username: "a-b" }, { platform: "threads", kind: "switch", username: "bob" }, { platform: "x-new", kind: "withdraw", username: "zed" }], ["x-new"]],
      ["a withdrawal, not the refresh shown", [{ platform: "test-example", kind: "withdraw", username: "a-b" }, { platform: "threads", kind: "switch", username: "bob" }], ["test-example"]],
    ];
    for (const [label, kinds, mismatches] of cases) {
      const s = await setup({ echoPublicInputs: true, backend: { cardState: state, submit: () => kindsAnswer(kinds) } });
      const cq = await toChosen(s, { threads: "bob" });
      assert.deepEqual(cq.rows.map((r) => r.kind), ["refresh", "switch"]);
      const done = await s.flow.proceed(cq.accounts);
      assert.deepEqual(done.mismatches, mismatches, label);
      assert.equal(s.flow.phase, "done", label);
    }
  });
});

describe("the PIN, the card and the windows", () => {
  test("the PIN waits at most 5 minutes for the second signature", async () => {
    assert.equal(IDLE_MS, 5 * 60_000);
    // Just under: everything goes on.
    const s = await setup({ echoPublicInputs: true });
    await toChosen(s);
    s.advance(IDLE_MS - 1);
    s.fireTimers();
    assert.equal(s.flow.stop, null);
    s.flow.back();
    const cq = pick(s, { threads: "alice" });
    await s.flow.proceed(cq.accounts);
    assert.equal(s.card.signed.length, 2);
    assert.equal(heldPin(s.flow), null, "the PIN is dropped after the second signature");

    // The timer fires: the PIN, the certificate and the signature are dropped; the screen is told.
    const t = await setup();
    await toStatus(t);
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
    assert.deepEqual(await stopOf(t.flow.proceed([{ platform: "threads", username: "alice" }])), { code: "idle" });
    assert.throws(() => t.flow.choose({ "test-example": "", threads: "alice" }), (e) => e instanceof FlowStop && e.stop.code === "idle");
    assert.equal(t.card.signed.length, 1);
    assert.equal(t.backend.log.length, n, "no request after");

    // The timer did not fire (a throttled background tab): the next step checks the time itself.
    const u = await setup();
    const cqu = await toChosen(u);
    u.advance(IDLE_MS + 60_000);
    assert.deepEqual(await stopOf(u.flow.proceed(cqu.accounts)), { code: "idle" });
    assert.deepEqual(u.idleStops, [{ code: "idle" }]);
    assert.equal(u.card.signed.length, 1);
    assert.equal(heldPin(u.flow), null);
  });

  test("cancel (取消 on steps 4 and 5): the PIN, the certificate and the signature are dropped, as when the wait runs out", async () => {
    type Held = { pin: unknown; cert: { der: Uint8Array; tbs: Uint8Array; issuerSignature: Uint8Array } | null; scopeSignature: Uint8Array | null; chosen: unknown };
    for (const where of ["status_known", "chosen"] as const) {
      const s = await setup();
      await toStatus(s);
      if (where === "chosen") pick(s, { threads: "alice" });
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
      assert.equal(held.chosen, null, `${where}: the list`);
      assert.ok([cert.der, cert.tbs, cert.issuerSignature, sig].every((b) => b.every((x) => x === 0)), `${where}: their bytes are zeros`);
      assert.equal(s.flow.cardStatus, null, `${where}: the card's state`);
      // The timer of the wait is gone: it does not fire later.
      s.advance(IDLE_MS);
      s.fireTimers();
      assert.deepEqual(s.idleStops, [], `${where}: no idle afterwards`);
      assert.throws(() => s.flow.choose({ "test-example": "", threads: "alice" }), (e) => e instanceof FlowStop);
      assert.ok((await stopOf(s.flow.proceed([{ platform: "threads", username: "alice" }]))) !== null);
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
    const cq = pick(s, { threads: "alice" });
    // The second signature: the PIN stays as it was, between the two signatures.
    const second = blockWindows(s.card, "sign", 1);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "card", card: "popup_blocked" });
    assert.equal(second.blocked(), 1);
    assert.equal(s.flow.stop, null);
    assert.equal(s.flow.phase, "chosen");
    assert.equal(s.card.signed.length, 1, "the card signed once");
    assert.equal(s.backend.submissions.length, 0);
    // A blocked window does not stretch the wait for the second signature.
    s.advance(IDLE_MS);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "idle" });

    const t = await setup({ echoPublicInputs: true });
    const cqt = await toChosen(t);
    blockWindows(t.card, "sign", 1);
    await stopOf(t.flow.proceed(cqt.accounts));
    const done = await t.flow.proceed(cqt.accounts);
    assert.deepEqual(done.kinds?.map((k) => k.kind), ["first"]);
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
    assert.equal(status.slots.length, 2);
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
    assert.equal((await own.flow.confirmCard(PIN)).slots.length, 2);

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

// Found in a review of web/ (2026-11-16): what the flow does when the server
// holds its answer, when cancel() comes while a step waits, when a card
// proof crosses midnight, when the card's state contradicts itself; and
// what it wipes.

/** Waits until the server has seen a request on `path`. */
/** Waits until the server got `count` requests on `path`. */
async function untilRequested(s: Setup, path: string, count = 1): Promise<void> {
  const got = () => s.backend.log.filter((r) => r.path === path).length >= count;
  for (let i = 0; i < 500 && !got(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(got(), `fewer than ${count} requests on ${path}`);
}

type Held = { pin: unknown; cert: unknown; scopeSignature: unknown; codeSignature: unknown };
const held = (f: CardProofFlow): Held => f as unknown as Held;

/** Nothing secret is left on the flow object. */
function assertNothingHeld(f: CardProofFlow, label: string): void {
  const h = held(f);
  assert.equal(h.pin, null, `${label}: the PIN`);
  assert.equal(h.cert, null, `${label}: the certificate`);
  assert.equal(h.scopeSignature, null, `${label}: the first signature`);
  assert.equal(h.codeSignature, null, `${label}: the second signature`);
}

/** Counts the calls of the card's sign(), successful or not. */
function countSigns(card: FakeCard): () => number {
  let n = 0;
  const original = card.sign.bind(card);
  card.sign = (m, p) => {
    n++;
    return original(m, p);
  };
  return () => n;
}

/** From a card read to a list: the PIN, then @alice on Threads. */
async function toChosenFromRead(s: Setup): Promise<Consequence> {
  return s.flow.choose(listOf(await s.flow.confirmCard(PIN), { threads: "alice" }));
}

describe("between the two signatures, the device's own limit holds whatever the server does", () => {
  test("card-state does not answer: 5 minutes after the first signature, everything is dropped and the screen is told", async () => {
    const s = await setup();
    await s.flow.readCard();
    const open = s.hold("/api/v1/card-state");
    const pending = stopOf(s.flow.confirmCard(PIN));
    await untilRequested(s, "/api/v1/card-state");
    const n = s.backend.log.length;
    s.advance(IDLE_MS - 1);
    s.fireTimers();
    assert.equal(s.flow.stop, null, "just under 5 minutes: still waiting");
    s.advance(1);
    s.fireTimers();
    assert.deepEqual(s.flow.stop, { code: "idle" });
    assert.deepEqual(s.idleStops, [{ code: "idle" }], "the screen is told");
    assert.equal(s.flow.phase, "stopped");
    assertNothingHeld(s.flow, "the wait ran out while card-state was pending");
    open();
    assert.deepEqual(await pending, { code: "idle" });
    assertNothingHeld(s.flow, "after the server answered");
    assert.equal(s.flow.cardStatus, null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.backend.log.length, n, "no request after");
  });

  test("the challenge does not answer: 5 minutes after the first signature, everything is dropped; the card does not sign again", async () => {
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosenAsking(s);
    const open = s.hold("/api/v1/challenges");
    const pending = stopOf(s.flow.proceed(cq.accounts));
    await untilRequested(s, "/api/v1/challenges", 2);
    s.advance(IDLE_MS);
    s.fireTimers();
    assert.deepEqual(s.idleStops, [{ code: "idle" }], "the screen is told");
    assertNothingHeld(s.flow, "the wait ran out while the challenge was pending");
    open();
    assert.deepEqual(await pending, { code: "idle" });
    assert.equal(s.card.signed.length, 1, "no second signature");
    assert.equal(s.backend.submissions.length, 0);
  });

  test("the challenge comes after the limit and the timer did not fire: the clock is read again before the card signs", async () => {
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosenAsking(s);
    const open = s.hold("/api/v1/challenges");
    const pending = stopOf(s.flow.proceed(cq.accounts));
    await untilRequested(s, "/api/v1/challenges", 2);
    s.advance(30 * 60_000); // a throttled tab: the timer has not run
    open();
    assert.deepEqual(await pending, { code: "idle" });
    assert.deepEqual(s.idleStops, [{ code: "idle" }]);
    assert.equal(s.card.signed.length, 1, "no second signature 30 minutes after the first");
    assert.equal(s.backend.submissions.length, 0);
    assertNothingHeld(s.flow, "after");
  });
});

describe("cancel() while a step waits: nothing is written, nothing is sent", () => {
  test("during the check of the first signature: no card-state, the PIN and the signature are not kept", async () => {
    const s = await setup();
    await s.flow.readCard();
    await s.flow.checksDone();
    const orig = crypto.subtle.verify.bind(crypto.subtle);
    let n = 0;
    crypto.subtle.verify = (async (...a: Parameters<typeof orig>) => {
      const r = await orig(...a);
      if (n++ === 0) s.flow.cancel();
      return r;
    }) as typeof crypto.subtle.verify;
    let stop: Stop;
    try {
      stop = await stopOf(s.flow.confirmCard(PIN));
    } finally {
      crypto.subtle.verify = orig;
    }
    assert.deepEqual(stop, { code: "state" });
    assertNoCardState(s);
    assertNothingHeld(s.flow, "cancelled");
    s.advance(60 * 60_000);
    s.fireTimers();
    assertNothingHeld(s.flow, "an hour later");
    assert.deepEqual(s.idleStops, []);
  });

  test("while the scoped ID is computed: no card-state", async () => {
    const s = await setup();
    await s.flow.readCard();
    await s.flow.checksDone();
    const hash2 = s.prover.hash2;
    let n = 0;
    s.prover.hash2 = async (a, b) => {
      if (n++ === 0) s.flow.cancel();
      return hash2(a, b);
    };
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), { code: "state" });
    assertNoCardState(s);
    assertNothingHeld(s.flow, "cancelled");
  });

  test("while the component signs (and reports its certificate): stopped by a check, not by an accident", async () => {
    const s = await setup({ signer: "signing" });
    await s.flow.readCard();
    await s.flow.checksDone();
    const sign = s.card.sign.bind(s.card);
    const returned: { signature: Uint8Array; certificate: Uint8Array | null }[] = [];
    s.card.sign = async (m, p) => {
      const r = await sign(m, p);
      s.flow.cancel();
      returned.push(r);
      return r;
    };
    // Before the fix this was a TypeError (checkSigner read the dropped certificate), not a FlowStop.
    const stop = await stopOf(s.flow.confirmCard(PIN));
    assert.deepEqual(stop, { code: "state" });
    assertNoCardState(s);
    assertNothingHeld(s.flow, "cancelled");
    assert.ok(returned[0]!.signature.every((b) => b === 0), "the signature's bytes are zeros");
    assert.ok(returned[0]!.certificate!.every((b) => b === 0), "the reported certificate's bytes are zeros");
  });

  test("while proceed() waits for the challenge: no second signature, nothing kept", async () => {
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosenAsking(s);
    const open = s.hold("/api/v1/challenges");
    const pending = stopOf(s.flow.proceed(cq.accounts));
    await untilRequested(s, "/api/v1/challenges", 2);
    s.flow.cancel();
    assertNothingHeld(s.flow, "cancelled");
    open();
    assert.deepEqual(await pending, { code: "state" });
    assert.equal(s.card.signed.length, 1);
    assert.equal(s.backend.submissions.length, 0);
    assertNothingHeld(s.flow, "after the challenge came");
  });

  test("while confirmCard() waits for the checks: the card is not asked to sign", async () => {
    const s = await setup();
    await s.flow.readCard();
    const signs = countSigns(s.card);
    const pending = stopOf(s.flow.confirmCard(PIN));
    s.flow.cancel();
    assert.deepEqual(await pending, { code: "state" });
    assert.equal(signs(), 0, "sign() was not called");
    assertNoCardState(s);
    assertNothingHeld(s.flow, "cancelled");
  });

  test("while readCard() checks the certificates: nothing kept, no request", async () => {
    const s = await setup();
    const pending = stopOf(s.flow.readCard());
    s.flow.cancel();
    assert.deepEqual(await pending, { code: "state" });
    assertNothingHeld(s.flow, "cancelled");
    assert.equal(s.flow.phase, "stopped");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.backend.log.length, 0, "no request");
  });

  test("while the proof is computed: nothing submitted, nothing kept", async () => {
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosen(s);
    const prove = s.prover.prove;
    s.prover.prove = async (name, inputs) => {
      const r = await prove(name, inputs);
      s.flow.cancel();
      return r;
    };
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "state" });
    assert.equal(s.backend.submissions.length, 0);
    assertNothingHeld(s.flow, "cancelled");
  });
});

// The challenge is asked for before the CRL's index (#553): the server takes
// the root of the second newest CRL only for a challenge issued before it
// learned of the newest, or at most 2 minutes after
// (spec/revocation-tree.md, "Who checks what"). proceed() signs that
// challenge if the first signature came within HELD_CHALLENGE_MS of asking
// for it and the date in Taiwan is the same, and asks for a new one
// otherwise.
describe("the challenge, asked for before the CRL", () => {
  /** A challenge of 2026-11-16 the fake server issues, in its one spelling. */
  const fresh = () => `2026-11-16.${encodeBase32(crypto.getRandomValues(new Uint8Array(16)))}`;

  /**
   * A server whose newest CRL changes when the test says so. Like the
   * Worker's, it takes the root the device has, now the second newest, only
   * for a challenge issued before the change (the 2 minutes after it are
   * past in these tests); otherwise `root`.
   */
  function changingCrl() {
    let changed = false;
    const before = new Set<string>();
    const issued: string[] = [];
    return {
      change: () => void (changed = true),
      issued,
      backend: {
        challenge: () => {
          const c = fresh();
          issued.push(c);
          if (!changed) before.add(c);
          return c;
        },
        submit: (body: Record<string, unknown>) => (before.has(body.challenge as string) ? null : { status: 400, body: { error: "root" } }),
      },
    };
  }

  test("the challenge is asked for after the server's config, before the CRL's index", async () => {
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    await s.flow.checksDone();
    // The circuit's file is fetched beside them, from the start.
    assert.deepEqual(s.beforeCrl()?.filter((r) => r.includes("/api/")), ["GET /api/v1/config", "POST /api/v1/challenges"]);
  });

  test("the CRL changes after the device downloaded it, before the submission: the card signs the challenge of before, and the record is taken", async () => {
    const c = changingCrl();
    const s = await setup({ echoPublicInputs: true, backend: c.backend });
    await s.flow.readCard();
    await s.flow.checksDone();
    // The mirror hands the server a newer CRL, and the cardholder takes 2 minutes over the PIN and one more over the list.
    c.change();
    s.advance(2 * 60_000);
    const cq = s.flow.choose(listOf(await s.flow.confirmCard(PIN), { threads: "alice" }));
    s.advance(60_000);
    const done = await s.flow.proceed(cq.accounts);
    assert.equal(done.seq, 1);
    assert.equal(c.issued.length, 1, "one challenge");
    assert.equal(s.backend.submissions[0]!.challenge, c.issued[0]);
    assert.ok(s.progress.includes("challenge"), "the challenge is checked at proceed()");
  });

  test("the first signature just under HELD_CHALLENGE_MS after it was asked for: the same challenge; at it, a new one, which is the one signed", async () => {
    for (const [after, requests] of [
      [HELD_CHALLENGE_MS - 1, 1],
      [HELD_CHALLENGE_MS, 2],
    ] as const) {
      const issued: string[] = [];
      const s = await setup({ echoPublicInputs: true, backend: { challenge: () => (issued.push(fresh()), issued.at(-1)) } });
      await s.flow.readCard();
      await s.flow.checksDone();
      s.advance(after);
      const cq = s.flow.choose(listOf(await s.flow.confirmCard(PIN), { threads: "alice" }));
      const done = await s.flow.proceed(cq.accounts);
      assert.equal(done.seq, 1, `${after}`);
      assert.equal(requestsOn(s, "/api/v1/challenges"), requests, `${after}`);
      assert.equal(s.backend.submissions[0]!.challenge, issued.at(-1), `${after}`);
      const code = await declarationCode(SCOPE, cq.accounts, issued.at(-1)!);
      assert.deepEqual(s.card.signed[1], code, `${after}: the card signed the challenge sent`);
    }
  });

  test("the first signature 3 minutes before the challenge was asked for, by a clock that went back: a new one", async () => {
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    await s.flow.checksDone();
    s.advance(-3 * 60_000);
    const cq = s.flow.choose(listOf(await s.flow.confirmCard(PIN), { threads: "alice" }));
    assert.equal((await s.flow.proceed(cq.accounts)).seq, 1);
    assert.equal(requestsOn(s, "/api/v1/challenges"), 2);
  });

  test("the first signature in time, proceed() almost 5 minutes after it: still the reading's challenge, at most 8 minutes old when the card signs", async () => {
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    await s.flow.checksDone();
    s.advance(HELD_CHALLENGE_MS - 1);
    const cq = s.flow.choose(listOf(await s.flow.confirmCard(PIN), { threads: "alice" }));
    s.advance(IDLE_MS - 1);
    assert.equal((await s.flow.proceed(cq.accounts)).seq, 1);
    assert.equal(requestsOn(s, "/api/v1/challenges"), 1);
  });

  test("a clock that went back since the challenge was asked for: a new one", async () => {
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    await s.flow.checksDone();
    s.advance(-1);
    const cq = s.flow.choose(listOf(await s.flow.confirmCard(PIN), { threads: "alice" }));
    assert.equal((await s.flow.proceed(cq.accounts)).seq, 1);
    assert.equal(requestsOn(s, "/api/v1/challenges"), 2);
  });

  for (const [label, answer] of [
    ["503 busy", { status: 503, body: { error: "busy" } }],
    ["429 rate_limited", { status: 429, body: { error: "rate_limited" } }],
    ["503 paused", { status: 503, body: { error: "paused" } }],
    ["500 internal", { status: 500, body: { error: "internal" } }],
  ] as const) {
    test(`the reading's challenge answered ${label}: the checks go on, nothing of it is counted, and proceed() asks for one`, async () => {
      let answers = 0;
      const s = await setup({ echoPublicInputs: true, backend: { challenge: () => (++answers === 1 ? answer : fresh()) } });
      const cq = await toChosen(s);
      const done = await s.flow.proceed(cq.accounts);
      assert.equal(done.seq, 1);
      assert.equal(requestsOn(s, "/api/v1/challenges"), 2);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(s.counted.filter((c) => c.event !== "step" && c.event !== "duration"), [], "no retry, no stop");
    });
  }

  test("the reading's challenge not answered: the checks go on, and proceed() asks for one", async () => {
    const s = await setup({ echoPublicInputs: true });
    const fetch = s.backend.fetch;
    let first = true;
    s.backend.fetch = async (path, init) => {
      if (path === "/api/v1/challenges" && first) {
        first = false;
        throw new TypeError("Failed to fetch");
      }
      return fetch(path, init);
    };
    const cq = await toChosen(s);
    assert.equal((await s.flow.proceed(cq.accounts)).seq, 1);
  });

  test("after a blocked window at the second signature, proceed() again signs the reading's challenge again", async () => {
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosen(s);
    blockWindows(s.card, "sign", 1);
    assert.equal((await stopOf(s.flow.proceed(cq.accounts))).code, "card");
    assert.equal((await s.flow.proceed(cq.accounts)).seq, 1);
    assert.equal(requestsOn(s, "/api/v1/challenges"), 1);
  });
});

describe("a card proof that crosses midnight", () => {
  // 2026-11-16 23:58 in Taiwan.
  const LATE = Date.UTC(2026, 10, 16, 15, 58, 0);

  test("the certificate's last day: proceed() checks it again with today's date, before the challenge", async () => {
    const s = await setup({ world: await makeWorld({ notAfter: "261116155959Z" }), start: LATE });
    const cq = await toChosen(s);
    const n = s.backend.log.length;
    s.advance(3 * 60_000); // 2026-11-17 00:01
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "certificate", problem: "expired", notAfter: "2026-11-16" });
    assert.equal(s.backend.log.length, n, "no challenge");
    assert.equal(s.card.signed.length, 1, "no second signature");
    assertNothingHeld(s.flow, "stopped");
  });

  test("the CRL's last day: proceed() checks its age again with today's date, before the challenge", async () => {
    const s = await setup({ crls: [{ serials: randomSerials(10), crlNumber: 100n, thisUpdate: daysBefore(3) }], start: LATE });
    const cq = await toChosen(s); // 3 days old, L = 3: usable on the 16th
    const n = s.backend.log.length;
    s.advance(3 * 60_000);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "revocation", problem: { code: "crl_stale", days: 4, maxDays: 3 } });
    assert.equal(s.backend.log.length, n, "no challenge");
    assert.equal(s.card.signed.length, 1, "no second signature");
  });

  // Since version 3 of the record rules (ADR-0018) no event rule reads a date: a list does the same on any date,
  // and what it does is not worked out again after midnight (#510).

  test("the button is pressed after midnight: the list confirmed before it is signed, dated the new day", async () => {
    const s = await setup({
      echoPublicInputs: true,
      start: LATE,
      backend: {
        challenge: () => "2026-11-17.000G40R40M30E209185GR38E1W",
        cardState: cardState({ last_card_proof: "2026-11-16", platforms: { threads: has("alice") } }),
      },
    });
    const cq = await toChosen(s, { threads: "bob" });
    assert.deepEqual(cq.rows.map((r) => r.kind), ["switch"]);
    s.advance(3 * 60_000); // 2026-11-17 00:01
    const done = await s.flow.proceed(cq.accounts);
    assert.equal(done.date, "2026-11-17");
    assert.equal(s.card.signed.length, 2, "the second signature");
    // The reading's challenge was asked for on 2026-11-16: proceed() asks for one of the new day.
    assert.equal(requestsOn(s, "/api/v1/challenges"), 2);
  });

  test("midnight passes while the challenge is on its way, and the list does the same on the new date: signed", async () => {
    const s = await setup({
      echoPublicInputs: true,
      // proceed() at 23:59:45 in Taiwan.
      start: Date.UTC(2026, 10, 16, 15, 56, 45),
      backend: {
        challenge: () => "2026-11-17.000G40R40M30E209185GR38E1W",
        cardState: cardState({ last_card_proof: "2026-11-16", platforms: { threads: has("alice") } }),
      },
    });
    const cq = await toChosenAsking(s, { threads: "alice" });
    const release = s.hold("/api/v1/challenges");
    const p = s.flow.proceed(cq.accounts);
    await untilRequested(s, "/api/v1/challenges", 2);
    s.advance(20_000);
    release();
    const done = await p;
    assert.equal(done.date, "2026-11-17");
  });

  test("3 records before midnight: after it, the same list is shown again as it was and can be signed", async () => {
    const s = await setup({ echoPublicInputs: true, start: LATE, backend: { challenge: () => "2026-11-17.000G40R40M30E209185GR38E1W", cardState: cardState({ last_card_proof: "2026-11-16", proofs_on_last_date: 3, platforms: { threads: has("alice") } }) } });
    await toStatus(s);
    assert.deepEqual(refused(() => pick(s)), { code: "blocked", reason: "daily_limit" });
    s.advance(3 * 60_000);
    const cq = pick(s);
    assert.deepEqual(cq.today, "2026-11-17");
    const done = await s.flow.proceed(cq.accounts);
    assert.equal(done.date, "2026-11-17");
  });
});

describe("a card-state answer the device cannot read, or the record rules cannot produce, is not read", () => {
  const D = "2026-11-04";
  const withThreads = (slotJson: Record<string, unknown>, lcp: string | null = D, extra: Record<string, unknown> = {}) => cardState({ last_card_proof: lcp, platforms: { threads: slotJson }, ...extra });
  const cases: [string, Record<string, unknown>][] = [
    // The rules cannot produce these.
    ["current is not the last declared account", withThreads(slot({ current: "bob", last_declared: "alice" }))],
    ["current without a last declared account", withThreads(slot({ current: "bob" }))],
    ["current without a last card proof", withThreads(has("alice"), null)],
    ["a last declared account without a last card proof", withThreads(slot({ last_declared: "alice" }), null)],
    ["switches on a slot that never had an account", withThreads(slot({ switch_count: 2 }))],
    ["switches on a card that has nothing else", withThreads(slot({ switch_count: 1 }), null)],
    ["a last card proof more than 3 days after today", withThreads(has("alice"), "2026-11-20")],
    ["dates in 2049", withThreads(has("alice"), "2049-12-31")],
    ["6 switches", withThreads(has("alice", { switch_count: 6 }))],
    ["-1 switches", withThreads(has("alice", { switch_count: -1 }))],
    ["a fraction of a switch", withThreads(has("alice", { switch_count: 1.5 }))],
    ["the switches as a string", withThreads(has("alice", { switch_count: "1" }))],
    ["no switch count", withThreads({ current: "alice", last_declared: "alice" })],
    ["records on the last card proof's date without a last card proof", cardState({ proofs_on_last_date: 1 })],
    ["no record on the last card proof's date", withThreads(has("alice"), D, { proofs_on_last_date: 0 })],
    ["a fraction of a record", withThreads(has("alice"), D, { proofs_on_last_date: 1.5 })],
    ["the count as a string", withThreads(has("alice"), D, { proofs_on_last_date: "1" })],
    ["no count", withThreads(has("alice"), D, { proofs_on_last_date: undefined })],
    ["a null count", cardState({ proofs_on_last_date: null })],
    ["no daily limit", withThreads(has("alice"), D, { daily_limit: undefined })],
    ["a daily limit as a string", withThreads(has("alice"), D, { daily_limit: "3" })],
    ["a negative daily limit", withThreads(has("alice"), D, { daily_limit: -1 })],
    ["a fraction of a daily limit", withThreads(has("alice"), D, { daily_limit: 2.5 })],
    // Not in its format.
    ["no platforms", (({ platforms: _p, ...rest }) => rest)(withThreads(has("alice")))],
    ["platforms as a list", { ...cardState({ last_card_proof: D }), platforms: [has("alice")] }],
    ["no last card proof", (({ last_card_proof: _l, ...rest }) => rest)(cardState())],
    ["a last card proof not a date", withThreads(has("alice"), "2026-13-01")],
    ["a known platform's entry not an object", withThreads("alice" as unknown as Record<string, unknown>)],
    ["a known platform's entry without current", withThreads({ last_declared: "alice", switch_count: 0 })],
    ["a known platform's entry without last_declared", withThreads({ current: null, switch_count: 0 })],
    ["an account not in its platform's format", withThreads(has("Alice!"))],
    ["an account in another platform's format", withThreads(has("a-b"))],
    ["a count of records not a number", cardState({ count: "137" })],
    // A platform the device does not know.
    ["an account on a platform ID not in the platform syntax", cardState({ last_card_proof: D, platforms: { "X_new": { current: "zed" } } })],
    ["an account with a quote, on a platform the device does not know", cardState({ last_card_proof: D, platforms: { "x-new": { current: 'z"d' } } })],
    ["an account with a backslash", cardState({ last_card_proof: D, platforms: { "x-new": { current: "z\\d" } } })],
    ["an empty account", cardState({ last_card_proof: D, platforms: { "x-new": { current: "" } } })],
    ["a non-ASCII account", cardState({ last_card_proof: D, platforms: { "x-new": { current: "zé" } } })],
    ["an account that is not a string", cardState({ last_card_proof: D, platforms: { "x-new": { current: 5 } } })],
    ["an entry that is not an object", cardState({ last_card_proof: D, platforms: { "x-new": "zed" } })],
    ["an entry without current", cardState({ last_card_proof: D, platforms: { "x-new": { last_declared: "zed" } } })],
    ["an account with no last card proof", cardState({ platforms: { "x-new": { current: "zed" } } })],
  ];
  for (const [name, state] of cases) {
    test(name, async () => {
      const s = await setup({ backend: { cardState: state } });
      await s.flow.readCard();
      assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), MALFORMED);
      assert.equal(s.flow.phase, "stopped");
      assertNothingHeld(s.flow, name);
    });
  }

  test("what the rules and the server can produce is read: 3 days ahead, a slot withdrawn with 5 switches, 3 records today, 4 (a daily limit lowered since), fields it does not know, a platform it does not know with no account", async () => {
    for (const state of [
      withThreads(has("alice"), "2026-11-19"),
      withThreads(slot({ last_declared: "alice", switch_count: 5 })),
      withThreads(has("alice"), "2026-11-16", { proofs_on_last_date: 3 }),
      withThreads(has("alice"), "2026-11-16", { proofs_on_last_date: 4 }),
      withThreads({ ...has("alice"), switch_dates: ["2026-03-02"], note: "x" }, D, { extra: { a: 1 } }),
      cardState({ last_card_proof: D, platforms: { threads: has("alice"), "Not An ID": { current: null }, "x-new": { current: null, whatever: true } } }),
    ]) {
      const s = await setup({ backend: { cardState: state } });
      await s.flow.readCard();
      const st = await s.flow.confirmCard(PIN);
      assert.equal(s.flow.phase, "status_known", JSON.stringify(state));
      assert.deepEqual(st.slots.map((x) => x.platform), ["test-example", "threads"]);
    }
  });
});

describe("what the flow wipes besides its own fields", () => {
  test("the certificate not chosen, the certificate the component reports, the circuit's inputs", async () => {
    const s = await setup({ signer: "signing", echoPublicInputs: true });
    const read = s.card.readCertificates.bind(s.card);
    let ders: Uint8Array[] = [];
    s.card.readCertificates = async () => (ders = await read());
    const sign = s.card.sign.bind(s.card);
    const reported: Uint8Array[] = [];
    s.card.sign = async (m, p) => {
      const r = await sign(m, p);
      reported.push(r.certificate!);
      return r;
    };
    await s.flow.readCard();
    assert.equal(ders.length, 2);
    assert.ok(ders[0]!.every((b) => b === 0), "the encryption certificate, not chosen: zeros");
    assert.ok(ders[1]!.some((b) => b !== 0), "the chosen one is kept until the end");
    const cq = await toChosenFromRead(s);
    assert.ok(reported[0]!.every((b) => b === 0), "the certificate the first signature came with: zeros");
    await s.flow.proceed(cq.accounts);
    assert.ok(reported[1]!.every((b) => b === 0), "the certificate the second signature came with: zeros");
    assert.ok(ders[1]!.every((b) => b === 0), "the chosen certificate after the submission: zeros");
    const inputs = s.proveCalls[0]!;
    for (const k of ["tbs", "scope", "declaration_code"]) assert.ok((inputs[k] as number[]).every((x) => x === 0), `inputs.${k}: zeros`);
    for (const k of ["scope_signature", "declaration_code_signature", "issuer_signature"]) {
      assert.ok((inputs[k] as string[]).every((x) => x === "0x0"), `inputs.${k}: no longer the signature's limbs`);
    }
  });
});

// Found when those fixes were checked again (2026-11-17): confirmCard()
// called a second time while the first was under way (a PIN typed again on
// section 2 and the button pressed again) had the card sign again, sent
// card-state again, and started a second timer without cancelling the first.
// That first timer later stopped a card proof whose record was already sent.

/** The promise's FlowStop, or "still running" if it has not settled within `ms`. */
async function settledWithin(p: Promise<unknown>, ms = 500): Promise<Stop | "still running"> {
  return Promise.race([stopOf(p), new Promise<"still running">((r) => setTimeout(() => r("still running"), ms))]);
}

/** Holds every call of the card's sign() until the returned function is called. */
function holdSigns(card: FakeCard): () => void {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const sign = card.sign.bind(card);
  card.sign = async (m, p) => {
    await gate;
    return sign(m, p);
  };
  return open;
}

async function until(f: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(f(), what);
}

const requestsOn = (s: Setup, path: string): number => s.backend.log.filter((r) => r.path === path).length;

const isState = (e: unknown): boolean => e instanceof FlowStop && e.stop.code === "state";

describe("a step called again while it is under way", () => {
  for (const where of ["the checks", "the card's signature", "card-state"] as const) {
    test(`confirmCard() again while the first waits for ${where}: refused (state); the card is not asked, nothing is sent, the first goes on`, async () => {
      const s = await setup();
      await s.flow.readCard();
      if (where !== "the checks") await s.flow.checksDone();
      let release: () => void = () => undefined;
      if (where === "card-state") release = s.hold("/api/v1/card-state");
      if (where === "the card's signature") release = holdSigns(s.card);
      const signs = countSigns(s.card);
      const first = s.flow.confirmCard(PIN);
      if (where === "card-state") await untilRequested(s, "/api/v1/card-state");
      if (where === "the card's signature") await until(() => signs() === 1, "the card was asked to sign");
      const calls = signs();
      const n = s.backend.log.length;

      assert.deepEqual(await settledWithin(s.flow.confirmCard(PIN)), { code: "state" });
      assert.equal(signs(), calls, "the card was not asked again");
      // While the checks run, they send requests of their own.
      if (where !== "the checks") assert.equal(s.backend.log.length, n, "no request");
      assert.equal(requestsOn(s, "/api/v1/card-state"), where === "card-state" ? 1 : 0, "card-state so far");
      assert.equal(s.flow.stop, null, "the first is not stopped");

      release();
      const status = await first;
      assert.equal(status.slots.length, 2);
      assert.equal(s.flow.phase, "status_known");
      assert.equal(heldPin(s.flow), PIN, "the first's PIN is held, as after any first signature");
      assert.equal(signs(), 1, "the card was asked once");
      assert.equal(s.card.signed.length, 1, "the card signed once");
      assert.equal(requestsOn(s, "/api/v1/card-state"), 1, "one card-state");
    });
  }

  test("confirmCard() again a minute later, then a declaration that ends after the first's 5 minutes: the card proof is not stopped", async () => {
    // The order of events that showed the problem: the first timer, never
    // cancelled, fired while the record was being submitted.
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    await s.flow.checksDone();
    const openState = s.hold("/api/v1/card-state");
    const first = s.flow.confirmCard(PIN);
    await untilRequested(s, "/api/v1/card-state");
    s.advance(60_000);
    const second = s.flow.confirmCard(PIN);
    second.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    openState();
    await first;
    const [secondResult] = await Promise.allSettled([second]);
    const cq = pick(s, { threads: "alice" });
    const openRecord = s.hold("/api/v1/records");
    s.advance(3 * 60_000 + 50_000); // 4 min 50 s after the first signature
    const pending = s.flow.proceed(cq.accounts);
    await untilRequested(s, "/api/v1/records");
    s.advance(10_000); // 5 min after the first signature
    s.fireTimers();
    assert.equal(s.flow.stop, null, "not stopped while the record is on its way");
    assert.deepEqual(s.idleStops, [], "the screen is not told to go back");
    openRecord();
    const done = await pending;
    assert.deepEqual(done.kinds?.map((k) => k.kind), ["first"]);
    assert.equal(s.flow.phase, "done");
    assert.equal(s.backend.submissions.length, 1);
    assert.ok(secondResult!.status === "rejected" && isState(secondResult!.reason), "the second confirmCard() was refused");
    assert.equal(s.card.signed.length, 2, "the scope string once, the declaration code once");
    assert.equal(requestsOn(s, "/api/v1/card-state"), 1, "one card-state");
  });

  test("readCard() again while the first reads: refused (state); the card is read once, the checks start once", async () => {
    const s = await setup();
    let reads = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const read = s.card.readCertificates.bind(s.card);
    s.card.readCertificates = async () => {
      reads++;
      await gate;
      return read();
    };
    const first = s.flow.readCard();
    await until(() => reads === 1, "the card was asked for its certificates");
    assert.deepEqual(await settledWithin(s.flow.readCard()), { code: "state" });
    assert.equal(reads, 1, "the card was not asked again");
    assert.equal(s.flow.stop, null, "the first is not stopped");
    open();
    assert.equal((await first).name, "測試用戶");
    assert.equal(s.flow.phase, "checking");
    await s.flow.checksDone();
    assert.equal(requestsOn(s, "/api/v1/config"), 1, "the checks started once");
  });

  test("proceed() again, choose() and back() while proceed() waits: refused (state); one challenge, one second signature", async () => {
    // proceed() leaves "chosen" before its first await: this held already.
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosenAsking(s);
    const open = s.hold("/api/v1/challenges");
    const first = s.flow.proceed(cq.accounts);
    await untilRequested(s, "/api/v1/challenges", 2);
    const n = s.backend.log.length;
    assert.deepEqual(await settledWithin(s.flow.proceed(cq.accounts)), { code: "state" });
    assert.throws(() => s.flow.choose({ "test-example": "", threads: "bob" }), isState);
    assert.throws(() => s.flow.back(), isState);
    assert.equal(s.backend.log.length, n, "no request");
    assert.equal(s.flow.stop, null);
    assert.equal(s.flow.phase, "signing");
    open();
    const done = await first;
    assert.deepEqual(done.accounts, [{ platform: "threads", username: "alice" }]);
    assert.equal(s.card.signed.length, 2);
    assert.equal(requestsOn(s, "/api/v1/challenges"), 2, "the reading's and proceed()'s");
    assert.equal(s.backend.submissions.length, 1);
  });

  test("resubmit() again while the first resubmission waits: refused (state); the record is sent once more, not twice", async () => {
    // resubmit() leaves "submit_failed" before its first await: this held already.
    let answer = { status: 500, body: { error: "internal" } as unknown };
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    const cq = await toChosen(s);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "internal", status: 500 });
    answer = { status: 201, body: { seq: 7, record_hash: "b".repeat(64), kinds: [{ platform: "threads", kind: "first", username: "alice", account_cards: 1 }] } };
    const open = s.hold("/api/v1/records");
    const first = s.flow.resubmit();
    await until(() => requestsOn(s, "/api/v1/records") === 2, "the record was sent again");
    assert.deepEqual(await settledWithin(s.flow.resubmit()), { code: "state" });
    open();
    assert.equal((await first).seq, 7);
    assert.equal(requestsOn(s, "/api/v1/records"), 2);
  });
});

describe("the wait for the second signature has one timer", () => {
  test("a second start of the wait cancels the first's timer", async () => {
    // confirmCard() is its only caller and no longer runs twice at once;
    // this holds the timer to the same rule on its own.
    const s = await setup();
    await toStatus(s); // the first timer: due 5 minutes from now
    s.advance(60_000);
    (s.flow as unknown as { startIdleTimer(): void }).startIdleTimer(); // the second: due a minute after the first
    s.advance(IDLE_MS - 60_000);
    s.fireTimers();
    assert.equal(s.flow.stop, null, "5 minutes after the first start: the first timer was cancelled");
    assert.deepEqual(s.idleStops, []);
    s.advance(60_000);
    s.fireTimers();
    assert.deepEqual(s.flow.stop, { code: "idle" }, "5 minutes after the second start");
    assert.deepEqual(s.idleStops, [{ code: "idle" }], "the screen is told once");
  });
});

describe("what the flow tells the screen as it goes (onProgress)", () => {
  test("each thing done, once: the card read, then the checks that need no signature (in any order), then the declaration", async () => {
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    await s.flow.checksDone();
    assert.deepEqual(s.progress.slice(0, 3), ["component", "certificates", "certificate"]);
    assert.deepEqual([...s.progress.slice(3)].sort(), ["circuit", "config", "crl", "engine", "tree"]);
    assert.ok(s.progress.indexOf("config") < s.progress.indexOf("crl") && s.progress.indexOf("crl") < s.progress.indexOf("tree"), "in each chain, in its order");
    const cq = await toChosenFromRead(s);
    await s.flow.proceed(cq.accounts);
    assert.deepEqual(s.progress.slice(8), ["challenge", "signed", "proved"]);
  });

  test("a revoked card: the CRL, but no tree; the screen hears nothing more once the flow stopped", async () => {
    const s = await setup({ crls: [{ serials: [...randomSerials(50), 0x1234567890abcdef1234567890abcdefn], crlNumber: 100n, thisUpdate: CRL_TIME }] });
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.checksDone()), { code: "revoked" });
    assert.ok(s.progress.includes("crl") && !s.progress.includes("tree"), JSON.stringify(s.progress));
    const n = s.progress.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.progress.length, n);
  });

  test("a platform table the device cannot read: no config event", async () => {
    const s = await setup({ backend: { platforms: [] } });
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.checksDone()), MALFORMED);
    assert.ok(!s.progress.includes("config") && !s.progress.includes("crl"), JSON.stringify(s.progress));
  });

  test("a challenge of another day: no challenge event, nothing after the stop", async () => {
    const s = await setup({ backend: { challenge: () => "2026-11-15.000G40R40M30E209185GR38E1W" } });
    const cq = await toChosen(s);
    const n = s.progress.length;
    await stopOf(s.flow.proceed(cq.accounts));
    assert.equal(s.progress.length, n);
  });
});

describe("no reader, and two certificates that pass", () => {
  test("no reader: its own stop, before any request", async () => {
    const s = await setup();
    (s.card as unknown as { opts: { noReader: boolean } }).opts.noReader = true;
    const stop = await stopOf(s.flow.readCard());
    assert.deepEqual(stop, { code: "card", card: "no_reader" });
    assert.deepEqual(s.progress, ["component"], "the reader's component answered; nothing read");
    assert.equal(s.backend.log.length, 0);
  });

  test("two certificates that both pass: ambiguous_certificate, nothing requested", async () => {
    const w = await makeWorld();
    const s = await setup({ world: w });
    const other = await makeWorld();
    (s.card as unknown as { opts: { certificates: Uint8Array[] } }).opts.certificates = [w.signingCert, other.signingCert];
    // The second world has its own issuer keys; the flow trusts both here.
    (s.flow as unknown as { deps: { issuers: unknown[] } }).deps.issuers = [...w.issuers, ...other.issuers];
    const stop = await stopOf(s.flow.readCard());
    assert.deepEqual(stop, { code: "certificate", problem: "ambiguous_certificate" });
    assert.equal(s.backend.log.length, 0);
  });
});

// The first submission's answer was lost (here: a 500, after which, in this
// story, the server had appended the record); the resubmission is answered
// challenge_used. The card's state, asked again, says whether the record is
// this card proof's: the card's list is the list submitted, and its last card
// proof is the record's date.
describe("a resubmission answered challenge_used (a fake server)", () => {
  async function lost(o: { before?: Record<string, unknown>; changes?: Record<string, string>; first?: { status: number; body: unknown } }): Promise<{ s: Setup; cq: Consequence }> {
    let calls = 0;
    const s = await setup({
      echoPublicInputs: true,
      backend: {
        ...(o.before && { cardState: o.before }),
        submit: () => (++calls === 1 ? (o.first ?? { status: 500, body: { error: "internal" } }) : { status: 400, body: { error: "challenge_used" } }),
      },
    });
    const cq = await toChosen(s, o.changes);
    return { s, cq };
  }
  const firstFails = async (s: Setup, cq: Consequence): Promise<void> => {
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "internal", status: 500 });
    assert.equal(s.flow.phase, "submit_failed");
  };
  const today = "2026-11-16";

  test("a first declaration: the card's list is the one sent, its last card proof today: done, without seq and kinds", async () => {
    const { s, cq } = await lost({});
    await firstFails(s, cq);
    s.backend.opts.cardState = cardState({ last_card_proof: today, platforms: { threads: has("alice") } });
    const done = await s.flow.resubmit();
    assert.deepEqual([done.seq, done.recordHash, done.kinds, done.mismatches, done.date], [null, null, null, [], today]);
    assert.deepEqual(done.accounts, [{ platform: "threads", username: "alice" }]);
    assert.deepEqual(done.expected.map((r) => r.kind), ["first"]);
    assert.equal(s.flow.phase, "done");
    assert.equal(requestsOn(s, "/api/v1/card-state"), 2, "the card's state asked again");
    assert.equal(requestsOn(s, "/api/v1/records"), 2);
    assert.equal(s.card.signed.length, 2, "no new signature");
  });

  test("two accounts, one on a platform the device does not know: both in the card's state", async () => {
    const before = cardState({ last_card_proof: "2026-11-04", platforms: { threads: has("alice"), "x-new": { current: "zed" } } });
    const { s, cq } = await lost({ before, changes: { "test-example": "a-b" } });
    await firstFails(s, cq);
    s.backend.opts.cardState = cardState({ last_card_proof: today, platforms: { "test-example": has("a-b"), threads: has("alice"), "x-new": { current: "zed" } } });
    const done = await s.flow.resubmit();
    assert.deepEqual(done.accounts.map((a) => a.platform), ["test-example", "threads", "x-new"]);
    assert.equal(done.kinds, null);
  });

  test("everything withdrawn: no account, last card proof today: done", async () => {
    const { s, cq } = await lost({ before: DECLARED, changes: { threads: "" } });
    await firstFails(s, cq);
    s.backend.opts.cardState = cardState({ last_card_proof: today, platforms: { threads: slot({ last_declared: "alice", switch_count: 1 }) } });
    const done = await s.flow.resubmit();
    assert.deepEqual([done.seq, done.kinds, done.accounts], [null, null, []]);
  });

  const notFound: [string, Record<string, unknown>][] = [
    ["nothing declared", cardState({})],
    ["another account", cardState({ last_card_proof: today, platforms: { threads: has("bob") } })],
    ["the account, an earlier day", cardState({ last_card_proof: "2026-11-15", platforms: { threads: has("alice") } })],
    ["withdrawn instead", cardState({ last_card_proof: today, platforms: { threads: slot({ last_declared: "alice" }) } })],
    ["an account more", cardState({ last_card_proof: today, platforms: { "test-example": has("a-b"), threads: has("alice") } })],
    ["an account more on a platform the device does not know", cardState({ last_card_proof: today, platforms: { threads: has("alice"), "x-new": { current: "zed" } } })],
    ["the platform without an entry", (() => {
      const st = cardState({ last_card_proof: today });
      delete (st.platforms as Record<string, unknown>).threads;
      return st;
    })()],
  ];
  for (const [label, state] of notFound) {
    test(`a list not in the card's state (${label}): the server's challenge_used stops the flow`, async () => {
      const { s, cq } = await lost({});
      await firstFails(s, cq);
      s.backend.opts.cardState = state;
      assert.deepEqual(await stopOf(s.flow.resubmit()), { code: "server", server: "challenge_used", status: 400 });
      assert.notEqual(s.flow.stop, null);
      const n = s.backend.log.length;
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(s.backend.log.length, n, "nothing after the stop");
    });
  }

  test("a withdrawal not in the card's state (still declared): challenge_used", async () => {
    const { s, cq } = await lost({ before: DECLARED, changes: { threads: "" } });
    await firstFails(s, cq);
    s.backend.opts.cardState = cardState({ last_card_proof: today, platforms: { threads: has("alice", { switch_count: 1 }) } });
    assert.deepEqual(await stopOf(s.flow.resubmit()), { code: "server", server: "challenge_used", status: 400 });
  });

  test("the card's state cannot be read then: that reason, not that nothing was recorded", async () => {
    const { s, cq } = await lost({});
    await firstFails(s, cq);
    s.backend.opts.cardState = { current: "Alice!" };
    assert.deepEqual(await stopOf(s.flow.resubmit()), MALFORMED);
  });

  test("challenge_used on the first submission (not a resubmission): stops; the card's state is not asked again", async () => {
    const { s, cq } = await lost({ first: { status: 400, body: { error: "challenge_used" } } });
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "challenge_used", status: 400 });
    assert.equal(requestsOn(s, "/api/v1/card-state"), 1);
  });
});

// The PIN is held until the second signature and no longer. Dropping it
// before the submission (dropSecrets) would hide a flow that kept it through the proof.
describe("the PIN after the second signature", () => {
  test("dropped as soon as the card signed the declaration code: not held while the proof is made", async () => {
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosen(s);
    let pinWhileProving: unknown = "prove() not called";
    const prove = s.prover.prove;
    s.prover.prove = async (name, inputs) => {
      pinWhileProving = heldPin(s.flow);
      return prove(name, inputs);
    };
    await s.flow.proceed(cq.accounts);
    assert.equal(pinWhileProving, null);
  });

  test("dropped when the submission does not get through (the record can be sent again; the PIN is not needed)", async () => {
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => ({ status: 500, body: { error: "internal" } }) } });
    const cq = await toChosen(s);
    await stopOf(s.flow.proceed(cq.accounts));
    assert.equal(s.flow.phase, "submit_failed");
    assert.equal(heldPin(s.flow), null);
  });
});

// A platform can be edited only if the server's table has a row the device can
// read and the page has its own definition of it (src/platforms.ts). A row of
// the table the page has no definition of is a platform the device does not know.
describe("a platform of the server's table the page has no definition of", () => {
  test("with an account: kept as it is, a row that cannot be changed; without one: not shown", async () => {
    const s = await setup({
      echoPublicInputs: true,
      knownPlatforms: ["threads"],
      backend: { cardState: cardState({ last_card_proof: "2026-11-04", platforms: { "test-example": has("a-b"), threads: has("alice") } }) },
    });
    const status = await toStatus(s);
    assert.deepEqual(
      status.slots.map((sl) => [sl.platform, sl.row === null, sl.current]),
      [
        ["test-example", true, "a-b"],
        ["threads", false, "alice"],
      ],
    );
    // Only Threads is offered; naming test-example is a program error.
    assert.deepEqual(refused(() => s.flow.choose({ "test-example": "a-c", threads: "alice" })), { code: "state" });
    const cq = s.flow.choose({ threads: "bob" });
    assert.deepEqual(cq.accounts, [
      { platform: "test-example", username: "a-b" },
      { platform: "threads", username: "bob" },
    ]);
    assert.deepEqual(cq.rows.map((r) => [r.platform, r.kind, r.row === null]), [
      ["test-example", "refresh", true],
      ["threads", "switch", false],
    ]);
    const done = await s.flow.proceed(cq.accounts);
    assert.deepEqual(done.record.accounts, cq.accounts);
  });

  test("without an account there: not shown, not in the list", async () => {
    const s = await setup({
      knownPlatforms: ["threads"],
      backend: { cardState: cardState({ last_card_proof: "2026-11-04", platforms: { "test-example": slot(), threads: has("alice") } }) },
    });
    const status = await toStatus(s);
    assert.deepEqual(status.slots.map((sl) => sl.platform), ["threads"]);
    assert.deepEqual(s.flow.choose({ threads: "alice" }).accounts, [{ platform: "threads", username: "alice" }]);
  });

  test("its entry is checked as any unknown platform's: only the minimum (a format the page cannot use is not applied)", async () => {
    // An account the test-example format would refuse ("A B") but every account satisfies: kept, not refused.
    const s = await setup({
      knownPlatforms: ["threads"],
      backend: { cardState: cardState({ last_card_proof: "2026-11-04", platforms: { "test-example": has("A B"), threads: has("alice") } }) },
    });
    const status = await toStatus(s);
    assert.equal(status.slots.find((sl) => sl.platform === "test-example")?.current, "A B");
  });
});

describe("one proof for the card's signatures (spec/device-checks.md)", () => {
  /** After the flow stopped with `stop`: no step goes on, and the engine is not asked again. */
  async function assertNoSecondProof(s: Setup, stop: Stop, list: Consequence): Promise<void> {
    assert.equal(s.proveCalls.length, 1, "one proof was asked for");
    assert.equal(s.flow.phase, "stopped");
    assertNothingHeld(s.flow, "the proof failed");
    for (const again of [() => s.flow.proceed(list.accounts), () => s.flow.resubmit(), () => s.flow.readCard(), () => s.flow.confirmCard(PIN)]) {
      assert.deepEqual(await stopOf(again()), stop);
    }
    assert.equal(s.proveCalls.length, 1, "no second proof");
    assert.equal(s.backend.submissions.length, 0, "nothing submitted");
  }

  test("the engine fails: the flow stops and drops both signatures; no step computes another proof", async () => {
    const s = await setup({ echoPublicInputs: true });
    const cq = await toChosen(s);
    const prove = s.prover.prove;
    s.prover.prove = async (name, inputs) => {
      await prove(name, inputs);
      throw new Error("the circuit has no proof for these inputs");
    };
    const stop = await stopOf(s.flow.proceed(cq.accounts));
    assert.deepEqual(stop, { code: "engine", detail: "the circuit has no proof for these inputs" });
    await assertNoSecondProof(s, stop, cq);
  });

  test("the proof says something else than the device expects: the same", async () => {
    // The stub's proof has no public inputs.
    const s = await setup();
    const cq = await toChosen(s);
    const stop = await stopOf(s.flow.proceed(cq.accounts));
    assert.deepEqual(stop, { code: "proof_check" });
    await assertNoSecondProof(s, stop, cq);
  });

  test("the record sent again after a failure of the server is the same proof, not another", async () => {
    let answer: { status: number; body: unknown } = { status: 500, body: { error: "internal" } };
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => answer } });
    const cq = await toChosen(s);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "internal", status: 500 });
    answer = { status: 201, body: { seq: 7, record_hash: "b".repeat(64), kinds: [{ platform: "threads", kind: "first", username: "alice", account_cards: 1 }] } };
    await s.flow.resubmit();
    assert.equal(s.proveCalls.length, 1, "one proof");
    assert.equal(s.backend.submissions[0]!.proof, s.backend.submissions[1]!.proof);
    assertNothingHeld(s.flow, "after the proof");
  });
});

describe("the counts the page sends (spec/counts.md; ADR-0032, ADR-0039)", () => {
  const sent = async (s: Setup): Promise<Record<string, unknown>[]> => {
    await new Promise((r) => setTimeout(r, 20));
    assertCounts(s);
    return s.counted;
  };
  const stepsOf = (counted: Record<string, unknown>[]): unknown[] => counted.filter((c) => c.event === "step").map((c) => c.step);

  test("a whole card proof: each step once, in order, under one attempt ID and the device ID the submission carries; nothing of the card, the account or the record", async () => {
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    // As the screen does: the PIN is asked for once the checks have passed.
    await s.flow.checksDone();
    const cq = s.flow.choose(listOf(await s.flow.confirmCard(PIN), { threads: "alice" }));
    const done = await s.flow.proceed(cq.accounts);
    const counted = await sent(s);
    // Every step, and the three timed steps' durations; nothing else.
    assert.deepEqual(counted.filter((c) => c.event !== "step").map((c) => [c.event, c.step]).sort(), [
      ["duration", "crl"],
      ["duration", "proved"],
      ["duration", "tree"],
    ]);
    const steps = stepsOf(counted);
    // The checks after the card is read run together: their steps come in any order, between the certificate and `checked`.
    const together = ["config", "circuit", "engine", "crl", "tree"];
    assert.deepEqual(steps.slice(0, 4), ["read", "component", "certificates", "certificate"]);
    assert.deepEqual([...steps.slice(4, 9)].sort(), [...together].sort());
    assert.deepEqual(steps.slice(9), ["checked", "pin", "scope_signed", "state", "chosen", "confirmed", "challenge", "code_signed", "proved", "done"]);
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
    assert.equal(new Set(counted.map((c) => c.device_id)).size, 1);
    // The submission carries the device ID, after the record's members; no other request does.
    const device = counted[0]!.device_id as string;
    assert.deepEqual(Object.keys(s.backend.submissions[0]!).at(-1), "device_id");
    assert.equal(s.backend.submissions[0]!.device_id, device);
    for (const r of s.backend.log.filter((r) => r.path !== "/api/v1/records")) assert.ok(!(r.path + r.body).includes(device), `${r.path} carries the device ID`);
    // Nothing of the card, the account, the record or the PIN in any count, apart from its random IDs (random-ids.ts).
    const all = JSON.stringify(counted.map(withoutRandomIds));
    for (const part of [done.scopedId, done.shortId, "alice", "threads", PIN, done.record.challenge, done.record.smt_root, "2026-11-16"]) assert.ok(!all.includes(part), part);
  });

  test("a wrong PIN and a blocked window: `retry` with the code, the same attempt goes on, and `pin` is sent once", async () => {
    const s = await setup({ echoPublicInputs: true });
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.confirmCard("000000")), { code: "card", card: "pin_incorrect" });
    blockWindows(s.card, "sign", 1);
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), { code: "card", card: "popup_blocked" });
    const status = await s.flow.confirmCard(PIN);
    // A list that is not possible is tried again too.
    assert.deepEqual(refused(() => s.flow.choose(listOf(status, { threads: "No Such Name" }))), { code: "username", platform: "threads" });
    await s.flow.proceed(s.flow.choose(listOf(status, { threads: "alice" })).accounts);
    const counted = await sent(s);
    assert.deepEqual(counted.filter((c) => c.event !== "step" && c.event !== "duration").map((c) => [c.event, c.reason]), [
      ["retry", "pin_incorrect"],
      ["retry", "popup_blocked"],
      ["retry", "username"],
    ]);
    assert.equal(stepsOf(counted).filter((x) => x === "pin").length, 1);
    assert.equal(stepsOf(counted).at(-1), "done");
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
  });

  test("a window blocked when the card is read: `retry`, and reading again is the same attempt", async () => {
    const s = await setup();
    blockWindows(s.card, "readCertificates", 2);
    assert.deepEqual(await stopOf(s.flow.readCard()), { code: "card", card: "popup_blocked" });
    assert.deepEqual(await stopOf(s.flow.readCard()), { code: "card", card: "popup_blocked" });
    await s.flow.readCard();
    await s.flow.checksDone();
    const counted = await sent(s);
    assert.deepEqual(counted.slice(0, 4).map((c) => c.step ?? `${String(c.event)} ${String(c.reason)}`), ["read", "retry popup_blocked", "retry popup_blocked", "component"]);
    assert.equal(stepsOf(counted).filter((x) => x === "read").length, 1);
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
  });

  test("a stop ends the attempt: the next card proof on the page has another attempt ID and the same device ID", async () => {
    const s = await setup({ backend: { cardState: { nonsense: true } } });
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), MALFORMED);
    const first = [...(await sent(s))];
    assert.deepEqual(first.at(-1), { client: "web", event: "stop", reason: "server_malformed_response", device_id: first[0]!.device_id, attempt_id: first[0]!.attempt_id, browser: "chrome", os: "windows", browser_version: "131", os_version: "10.0" });
    // Every step called again throws the same stop, and tells the counts nothing more.
    await stopOf(s.flow.confirmCard(PIN));
    await stopOf(s.flow.readCard());
    assert.equal((await sent(s)).length, first.length);

    const again = await setup({ echoPublicInputs: true });
    const second = new CardProofFlow({ ...(again.flow as unknown as { deps: ConstructorParameters<typeof CardProofFlow>[0] }).deps, counts: s.counts });
    await second.readCard();
    await second.checksDone();
    const later = (await sent(s)).slice(first.length);
    assert.equal(later[0]!.step, "read");
    assert.equal(new Set(later.map((c) => c.attempt_id)).size, 1);
    assert.notEqual(later[0]!.attempt_id, first[0]!.attempt_id);
    assert.equal(later[0]!.device_id, first[0]!.device_id);
  });

  test("the page opened, then the card read: `open` and the first card proof are one attempt; a card read again without a stop is another", async () => {
    const s = await setup();
    s.counts.step("open");
    await s.flow.readCard();
    await s.flow.checksDone();
    s.flow.cancel();
    const first = [...(await sent(s))];
    assert.deepEqual(stepsOf(first).slice(0, 2), ["open", "read"]);
    assert.equal(new Set(first.map((c) => c.attempt_id)).size, 1);
    // Leaving a card proof is no stop: nothing says so.
    assert.ok(first.every((c) => c.event === "step" || c.event === "duration"));
    const again = await setup();
    const second = new CardProofFlow({ ...(again.flow as unknown as { deps: ConstructorParameters<typeof CardProofFlow>[0] }).deps, counts: s.counts });
    await second.readCard();
    const later = (await sent(s)).slice(first.length);
    assert.equal(later[0]!.step, "read");
    assert.notEqual(later[0]!.attempt_id, first[0]!.attempt_id);
  });

  test("a check that fails while the card's checks run is told when it fails, and once", async () => {
    const s = await setup({ tamperCircuit: true });
    const stop = await readAndWait(s);
    assert.equal(stop?.code, "artifact");
    assert.deepEqual((await sent(s)).filter((c) => c.event === "stop").map((c) => c.reason), ["artifact"]);
    // The step that ends the flow on it tells nothing more; the file's path is in no count.
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), stop);
    const counted = await sent(s);
    assert.deepEqual(counted.filter((c) => c.event === "stop").map((c) => c.reason), ["artifact"]);
    assert.ok(!JSON.stringify(counted).includes("circuits"));
    // After its stop the card proof has no step: the PIN that was given is not one, and no other attempt begins.
    assert.ok(!stepsOf(counted).includes("pin"));
    assert.equal(counted.at(-1)!.event, "stop");
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
  });

  test("the record sent again: an action, and `retry` for the submission that did not get through", async () => {
    let answers = 0;
    const s = await setup({ echoPublicInputs: true, backend: { submit: () => (++answers === 1 ? { status: 500, body: { error: "internal" } } : { status: 201, body: { seq: 1, record_hash: "00".repeat(32), ordinal: 1, kinds: [{ platform: "threads", kind: "first", username: "alice", account_cards: 1 }] } }) } });
    const cq = await toChosen(s);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "internal", status: 500 });
    await s.flow.resubmit();
    const counted = await sent(s);
    assert.deepEqual(counted.filter((c) => c.event !== "step" && c.event !== "duration").map((c) => [c.event, c.reason ?? c.action]), [
      ["retry", "server_internal"],
      ["action", "resubmit"],
    ]);
    assert.equal(stepsOf(counted).at(-1), "done");
    // Both submissions carry the device ID.
    assert.deepEqual(s.backend.submissions.map((b) => b.device_id), [counted[0]!.device_id, counted[0]!.device_id]);
  });

  test("too many people to the card's state, then asked again: `retry` with `server_busy`, the same attempt goes on, and the card signs once", async () => {
    let answers = 0;
    const s = await setup({ echoPublicInputs: true, backend: { cardStateReply: () => (++answers === 1 ? { status: 503, body: { error: "busy" } } : null) } });
    await s.flow.readCard();
    assert.deepEqual(await stopOf(s.flow.confirmCard(PIN)), { code: "server", server: "busy", status: 503 });
    assert.equal(s.flow.phase, "card_state_failed");
    await s.flow.retryCardState();
    const done = await s.flow.proceed(s.flow.choose(listOf(s.flow.cardStatus!, { threads: "alice" })).accounts);
    assert.equal(done.seq, 1);
    const counted = await sent(s);
    assert.deepEqual(counted.filter((c) => c.event !== "step" && c.event !== "duration").map((c) => [c.event, c.reason]), [["retry", "server_busy"]]);
    assert.equal(stepsOf(counted).filter((st) => st === "scope_signed").length, 1);
    assert.equal(stepsOf(counted).at(-1), "done");
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
  });

  test("too many people to the challenge, then proceed() again: `retry` with `server_rate_limited`, and the same attempt is done", async () => {
    let answers = 0;
    // The first answer is the reading's challenge; proceed() asks for its own (toChosenAsking).
    const s = await setup({ echoPublicInputs: true, backend: { challenge: () => (++answers === 2 ? { status: 429, body: { error: "rate_limited" } } : `2026-11-16.${"0".repeat(26)}`) } });
    const cq = await toChosenAsking(s);
    assert.deepEqual(await stopOf(s.flow.proceed(cq.accounts)), { code: "server", server: "rate_limited", status: 429 });
    assert.equal(s.flow.phase, "chosen");
    const done = await s.flow.proceed(cq.accounts);
    assert.equal(done.seq, 1);
    const counted = await sent(s);
    assert.deepEqual(counted.filter((c) => c.event !== "step" && c.event !== "duration").map((c) => [c.event, c.reason]), [["retry", "server_rate_limited"]]);
    assert.equal(stepsOf(counted).at(-1), "done");
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
  });

  test("the timed steps: each sends how long it took, once it is done, as a duration of the table measured on the flow's clock", async () => {
    const s = await setup({ echoPublicInputs: true, takes: { crl: 2_500, tree: 45_000, proved: 200_000 } });
    const cq = await toChosen(s);
    assert.equal((await s.flow.proceed(cq.accounts)).seq, 1);
    const counted = await sent(s);
    const durations = counted.filter((c) => c.event === "duration");
    assert.deepEqual(
      durations.map((c) => [c.step, c.took]).sort(),
      [
        ["crl", "1s_3s"],
        ["proved", "gt_3m"],
        ["tree", "30s_60s"],
      ],
    );
    // In the attempt, and no time in any count.
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
    for (const c of durations) assert.deepEqual(Object.keys(c).filter((k) => !["client", "event", "step", "took", "device_id", "attempt_id", "browser", "os", "browser_version", "os_version", "reader"].includes(k)), []);
  });

  for (const [ms, took] of [[0, "lt_1s"], [1_000, "1s_3s"], [3_000, "3s_10s"], [10_000, "10s_30s"], [30_000, "30s_60s"], [60_000, "1m_3m"], [180_000, "gt_3m"]] as const) {
    test(`a proof that took ${ms} ms on the flow's clock is ${took}`, async () => {
      const s = await setup({ echoPublicInputs: true, takes: { proved: ms } });
      const cq = await toChosen(s);
      await s.flow.proceed(cq.accounts);
      const counted = await sent(s);
      assert.deepEqual(counted.filter((c) => c.event === "duration" && c.step === "proved").map((c) => c.took), [took]);
    });
  }

  test("the card reader's name: in every count once the card was read, and in none before", async () => {
    const s = await setup({ echoPublicInputs: true, readerName: "ACS ACR39U ICC Reader 0" });
    const cq = await toChosen(s);
    await s.flow.proceed(cq.accounts);
    const counted = await sent(s);
    const at = counted.findIndex((c) => c.step === "certificates");
    assert.ok(at > 0);
    assert.deepEqual(new Set(counted.slice(0, at).map((c) => c.reader ?? null)), new Set([null]));
    assert.deepEqual(new Set(counted.slice(at).map((c) => c.reader)), new Set(["ACS ACR39U ICC Reader 0"]));
    assert.equal(stepsOf(counted).at(-1), "done");
  });

  test("a card reader's name not in its form: no reader in any count, and nothing in its place", async () => {
    const s = await setup({ echoPublicInputs: true, readerName: "Microsoft Usbccid Smartcard Reader (WUDF) 0" });
    const cq = await toChosen(s);
    await s.flow.proceed(cq.accounts);
    const counted = await sent(s);
    assert.ok(counted.every((c) => !("reader" in c)));
    assert.ok(!JSON.stringify(counted).includes("Usbccid"));
  });

  test("a timed step done after the card proof was left sends no duration: the next card proof's attempt holds none of it", async () => {
    let release!: () => void;
    const s = await setup({ crlHeld: new Promise<void>((r) => (release = r)), takes: { crl: 2_500 } });
    await s.flow.readCard();
    s.flow.cancel();
    release();
    await new Promise((r) => setTimeout(r, 200));
    const counted = await sent(s);
    assert.deepEqual(counted.filter((c) => c.event === "duration"), []);
    assert.equal(new Set(counted.map((c) => c.attempt_id)).size, 1);
  });

  test("a timed step that did not get done sends no duration", async () => {
    const s = await setup({ echoPublicInputs: true, engineFails: true, takes: { crl: 2_500 } });
    await stopOf(toChosen(s));
    const counted = await sent(s);
    assert.deepEqual(counted.filter((c) => c.event === "duration" && c.step === "proved"), []);
    // The CRL was done before the engine failed: its duration was sent.
    assert.deepEqual(counted.filter((c) => c.event === "duration" && c.step === "crl").map((c) => c.took), ["1s_3s"]);
  });

  for (const countsAre of ["failing", "held"] as const) {
    test(`counts that are ${countsAre === "failing" ? "refused by the network" : "never answered"}: the card proof is made as ever, and none is sent twice`, async () => {
      const s = await setup({ echoPublicInputs: true, countsAre });
      const cq = await toChosen(s);
      const done = await s.flow.proceed(cq.accounts);
      assert.equal(done.seq, 1);
      const counted = await sent(s);
      assert.equal(stepsOf(counted).at(-1), "done");
      // Each step once, each timed step's duration once, and nothing else.
      assert.equal(new Set(stepsOf(counted)).size, stepsOf(counted).length);
      const durations = counted.filter((c) => c.event === "duration").map((c) => c.step);
      assert.equal(new Set(durations).size, durations.length);
      assert.equal(stepsOf(counted).length + durations.length, counted.length);
    });
  }

  test("the card proof device ID is kept with the date it was made on, replaced 31 days after it, and the old one is kept nowhere", async () => {
    const s = await setup();
    const first = s.counts.deviceId()!;
    assert.equal(s.idStorage.get(DEVICE_ID_KEY), `${first}.2026-11-16`);
    assert.deepEqual([...s.idStorage.keys()], [DEVICE_ID_KEY]);
    s.advance(30 * 86_400_000);
    assert.equal(s.counts.deviceId(), first, "30 days after: the same");
    s.advance(86_400_000);
    const second = s.counts.deviceId();
    assert.notEqual(second, first);
    assert.equal(s.idStorage.get(DEVICE_ID_KEY), `${second}.2026-12-17`);
    assert.ok(![...s.idStorage.values()].join().includes(first));
    // A count sent from now on carries the new one.
    s.counts.step("open");
    assert.equal((await sent(s)).at(-1)!.device_id, second);
  });
});
