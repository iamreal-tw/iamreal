// The headless browser test's page: the real engine, tree workers, storage
// and same-origin fetch, with a fake card of test keys and test issuer keys.
// It runs the card proofs the fixture asks for in one page load (reusing the
// one engine, ADR-0013), then reports what happened to the test server.
import { dataOriginFetch, sameOriginFetch } from "../../src/api.ts";
import { FakeCard } from "../../src/card/fake.ts";
import { startTreeBuilder, treeWorkerCount } from "../../src/crl/parallel.ts";
import { cardProofCounts } from "../../src/counts.ts";
import { CardProofFlow, FlowStop } from "../../src/flow.ts";
import type { IssuerKey } from "../../src/issuers.ts";
import { BB_WASM_PATH } from "../../src/index.ts";
import { proofEngine } from "../../src/prover/engine.ts";
import type { Choice } from "../../src/flow.ts";
import { localStorageStore } from "../../src/storage.ts";

const t0 = performance.now();
const timings: { step: string; ms: number; run: number }[] = [];
let run = -1;
const onTiming = (step: string, ms: number) => timings.push({ step, ms: Math.round(ms), run });

const violations: string[] = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));

interface Fixture {
  certificates: string[];
  cardKeyPkcs8: string;
  pin: string;
  issuers: { name: "G2" | "G3"; modulus: string; bits: 2048 | 4096 }[];
  /** Per card proof, the rows the cardholder changes (platform: account, "" for none); the others stay as they are. */
  runs: Record<string, string>[];
  maxThreads?: number;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function storageContents() {
  const idb = "databases" in indexedDB ? (await indexedDB.databases()).map((d) => d.name) : ["(cannot list)"];
  return {
    localStorage: Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).map((k) => [k, localStorage.getItem(k)])),
    sessionStorage: sessionStorage.length,
    indexedDB: idb,
    caches: "caches" in self ? await caches.keys() : [],
    cookies: document.cookie,
  };
}

async function main() {
  const wasmPath = new URL(BB_WASM_PATH, location.origin).href;
  const fx: Fixture = await (await sameOriginFetch("/__fixture.json")).json();
  // Start the engine first, as the page does when it opens.
  const prover = proofEngine({
    fetch: sameOriginFetch,
    wasmPath,
    maxThreads: fx.maxThreads,
    onTiming: (step, ms) => timings.push({ step: `engine_${step}`, ms: Math.round(ms), run: -1 }),
  });
  const engineReady = prover.ready().then((mode) => ({ mode, ms: Math.round(performance.now() - t0) }));

  const issuers: IssuerKey[] = fx.issuers.map((i) => ({ name: i.name, modulus: BigInt("0x" + i.modulus), bits: i.bits }));
  const signingKey = await crypto.subtle.importKey("pkcs8", b64(fx.cardKeyPkcs8), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  // The page's counts, as src/index.ts makes them: one for every card proof of the page.
  const counts = cardProofCounts({
    fetch: sameOriginFetch,
    storage: localStorage,
    clock: () => Date.now(),
    random: (bytes) => crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
    userAgent: navigator.userAgent,
  });
  const results = [];
  for (const [i, r] of fx.runs.entries()) {
    run = i;
    // The reader's name as the test component reports it (fake-component.ts).
    const card = new FakeCard({ certificates: fx.certificates.map(b64), signingKey, pin: fx.pin, readerName: "Fake Reader 0" });
    const flow = new CardProofFlow(
      {
        proofLog: "test",
        issuers,
        knownPlatforms: new Set(["test-example", "threads"]),
        fetch: sameOriginFetch,
        // The test's server plays the data domain too: the page's own origin.
        dataFetch: dataOriginFetch(""),
        clock: () => Date.now(),
        store: localStorageStore(),
        card,
        prover,
        startTreeBuilder: () => startTreeBuilder(treeWorkerCount(navigator.hardwareConcurrency ?? 1), wasmPath),
        onTiming,
        counts,
      },
    );
    const start = performance.now();
    try {
      const read = await flow.readCard();
      // The screen shows the PIN field only after the checks that need no signature.
      await flow.checksDone();
      const status = await flow.confirmCard(fx.pin);
      // The cardholder edits the list: every platform offered, as it is unless the run changes it.
      const entries: Choice = Object.fromEntries(status.slots.filter((s) => s.row !== null).map((s) => [s.platform, s.platform in r ? r[s.platform]! : (s.current ?? "")]));
      // The screen shows the list to be signed, and the cardholder confirms it.
      const consequence = flow.choose(entries);
      const done = await flow.proceed(consequence.accounts);
      results.push({ ok: true, name: read.name, status, consequence, done, ms: Math.round(performance.now() - start), signed: card.signed.length });
    } catch (e) {
      results.push({ ok: false, stop: e instanceof FlowStop ? e.stop : String(e), ms: Math.round(performance.now() - start) });
    }
  }
  return {
    results,
    engine: await engineReady,
    crossOriginIsolated: self.crossOriginIsolated,
    cores: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    timings,
    storage: await storageContents(),
    violations,
  };
}

const report = (body: unknown) =>
  fetch("/__report", { method: "POST", body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });

main().then(report, (e) => report({ error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e), violations }));
