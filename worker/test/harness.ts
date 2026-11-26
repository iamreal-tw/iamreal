// The tool every test of the back end uses: the whole Worker in the local
// workerd, built with the test build (test/build.ts), next to a fake MOICA.
// A test sends it HTTP requests, runs its schedule, reads the files it wrote
// to the simulated R2 bucket, and sets its clock. Nothing here needs a
// Cloudflare account, and nothing sends a request to MOICA.
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createTestHarness, unstable_readConfig } from "wrangler";
import { siteHeaders } from "../scripts/site-files.ts";
import { CIRCUITS } from "../src/circuits.ts";
import type { NewestCrls } from "../src/crl-index.ts";
import type { IssuerKey, IssuerName } from "../src/issuers.ts";
import { CRL_CATCH_UP_MS } from "../src/round-budget.ts";
import type { BucketFault, CardToWrite, KeptRecords, PagePlanQuestion, PagePlans, RuleEvent, RuleStateAnswer, StoredProofLog, StoredViews, TestSettings } from "../test-build/card-door.ts";
import { TEST_CRL_PATHS } from "../test-build/crl-paths.ts";
import { WORKER_DIR, buildWorker } from "./build.ts";
import { testIssuers } from "./crls.ts";

export { testIssuers } from "./crls.ts";

/** The cron expression of the test environment (wrangler.jsonc). */
export const HOURLY = "0 * * * *";

/** What the fake MOICA does with a request for one issuer key's CRL. */
type Answer =
  | { readonly kind: "body"; readonly body: Uint8Array; readonly chunked: boolean }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "cut"; readonly sent: Uint8Array; readonly contentLength: number | undefined }
  | { readonly kind: "stall"; readonly sent: Uint8Array | undefined };

/** One request the fake MOICA received. */
export interface MoicaRequest {
  readonly issuer: IssuerName | undefined;
  readonly path: string;
  readonly userAgent: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** A local server in MOICA's place: one CRL per issuer key, or one of the ways an answer goes wrong. */
export class FakeMoica {
  readonly origin: string;
  readonly requests: MoicaRequest[] = [];
  readonly #server: Server;
  readonly #answers = new Map<string, Answer>();

  private constructor(server: Server) {
    this.#server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  static async start(): Promise<FakeMoica> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const moica = new FakeMoica(server);
    server.on("request", (req, res) => {
      const path = req.url ?? "";
      const issuer = (Object.keys(TEST_CRL_PATHS) as IssuerName[]).find((i) => TEST_CRL_PATHS[i] === path);
      moica.requests.push({ issuer, path, userAgent: req.headers["user-agent"], headers: req.headers });
      const answer = moica.#answers.get(path);
      const type = { "Content-Type": "application/pkix-crl" };
      if (answer === undefined) return void res.writeHead(404).end();
      switch (answer.kind) {
        case "status":
          return void res.writeHead(answer.status).end("error");
        case "body":
          // Without Content-Length, Node sends the body chunked.
          return void res.writeHead(200, { ...type, ...(!answer.chunked && { "Content-Length": answer.body.length }) }).end(answer.body);
        case "cut":
          // Without Content-Length, Node sends the body chunked.
          res.writeHead(200, { ...type, ...(answer.contentLength !== undefined && { "Content-Length": answer.contentLength }) });
          return void res.write(answer.sent, () => res.socket?.destroy());
        case "stall":
          if (answer.sent === undefined) return; // not even the status line
          res.writeHead(200, { ...type, "Content-Length": answer.sent.length + 1000 });
          return void res.write(answer.sent);
      }
    });
    return moica;
  }

  /** From now on this issuer's address gives these bytes. */
  serve(issuer: IssuerName, body: Uint8Array, how: "with Content-Length" | "chunked" = "with Content-Length"): void {
    this.#answers.set(TEST_CRL_PATHS[issuer], { kind: "body", body, chunked: how === "chunked" });
  }

  /** From now on this issuer's address answers with this HTTP status. */
  fail(issuer: IssuerName, status: number): void {
    this.#answers.set(TEST_CRL_PATHS[issuer], { kind: "status", status });
  }

  /**
   * From now on this issuer's address answers 200, sends `sent` and closes
   * the connection: with a Content-Length that promised `contentLength`
   * bytes, or chunked, without the chunk that ends the body.
   */
  cutOff(issuer: IssuerName, sent: Uint8Array, contentLength: number | "chunked"): void {
    this.#answers.set(TEST_CRL_PATHS[issuer], { kind: "cut", sent, contentLength: contentLength === "chunked" ? undefined : contentLength });
  }

  /**
   * From now on this issuer's address keeps the connection open and sends
   * nothing more: nothing at all, or 200 and `sent` of a longer body.
   */
  stall(issuer: IssuerName, sent?: Uint8Array): void {
    this.#answers.set(TEST_CRL_PATHS[issuer], { kind: "stall", sent });
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }
}

/** A file in the simulated R2 bucket. */
export interface StoredFile {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly cacheControl: string | undefined;
  readonly contentType: string | undefined;
  readonly uploaded: Date;
}

/** What the tests use of an R2 bucket binding. */
interface Bucket {
  put(key: string, value: Uint8Array | string, options?: { httpMetadata?: { cacheControl?: string; contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { cacheControl?: string; contentType?: string }; uploaded: Date } | null>;
}

export interface TestWorker {
  /** Where the Worker listens; for requests that must go over a real socket. */
  readonly url: URL;
  readonly moica: FakeMoica;
  /** Sends the Worker an HTTP request. A relative address is the Worker's own. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Runs the hourly schedule once and waits for it. `outcome` is "ok" unless it threw. */
  runSchedule(): Promise<{ outcome: string }>;
  /** The files in the simulated R2 bucket, in the order of their keys. */
  files(prefix?: string): Promise<StoredFile[]>;
  /**
   * Puts a file into the simulated R2 bucket, or takes one out, behind the
   * Worker's back: how a test leaves the bucket as a round that broke off
   * would have left it. `cacheControl` and `contentType` are the
   * `Cache-Control` and the `Content-Type` the file carries; without
   * them, none.
   */
  putFile(key: string, bytes: Uint8Array | string, cacheControl?: string, contentType?: string): Promise<void>;
  deleteFile(key: string): Promise<void>;
  /**
   * What the proof log's Durable Object knows of the CRL archive, through the
   * test build's `GET /__test/newest-crls`.
   */
  newestCrls(): Promise<NewestCrls>;
  /**
   * Stops the whole Worker and its Durable Objects and starts them again.
   * What they keep in storage and the bucket's files stay; what they held
   * in memory, the test clock and the test's settings included, is gone.
   * (`proofLog.restart()` stops only the proof log's object.)
   */
  restart(): Promise<void>;
  /** From now on the Worker's clock shows `time`. */
  setClock(time: Date): Promise<void>;
  /**
   * From now on the environment has these settings in place of
   * wrangler.jsonc's (test build, `PUT /__test/settings`). A proof log's object
   * that is running keeps the ones it started with until `proofLog.restart()`;
   * one they no longer name is started anew at the next `switchProofLog`.
   */
  setSettings(settings: TestSettings): Promise<void>;
  /**
   * `setSettings`, as the deploy that names another proof log's object does
   * it (README.md, "清空測試的證明紀錄"): after a deploy an object starts
   * with the new settings, at the latest some minutes later, so the object
   * the settings named until now is stopped, and started with the new
   * settings, which make it a replaced one: it says so in one line and has
   * no alarm from then on. Without this it would go on running with the
   * settings it started with (the local workerd never lets an object
   * hibernate), still taking itself for the proof log's object, and its
   * alarm would publish its proof log into the bucket the next one uses, at
   * whatever moment it rings, in any later test. So is every object that
   * an earlier `setSettings` stopped naming. With settings no object starts
   * with (the Worker answers 500), they are only stopped, and started at the
   * next of these whose settings they start with.
   */
  switchProofLog(settings: TestSettings): Promise<void>;
  /** What the Worker has written to its log since it started. */
  logLines(): string[];
  /**
   * The method and path of every request that reached the Worker's code
   * since this was last asked (test build, `GET /__test/seen`), in order:
   * a request Static Assets answered by itself is not among them.
   */
  seen(): Promise<string[]>;
  /**
   * Asks `POST /api/v1/challenges` for a challenge and returns it. With
   * `randomHex`, 16 bytes in hex, the challenge has those bytes in place of
   * random ones (test build, `PUT /__test/proof-log/next-random`): how a test
   * gets the challenge a proof was made for, or the same challenges in two
   * runs.
   */
  issueChallenge(randomHex?: string): Promise<string>;
  /**
   * Which proof verifier `records` asks from now on (test build,
   * `PUT /__test/verifier`): "real" is the deployed Worker's, and what a
   * test worker starts with; "stand-in" judges a proof by its first byte
   * alone (0 accepted, 1 rejected, 2 the verifier cannot run, 3 accepted
   * with the clock a millisecond later), for the
   * tests that are about everything but the proof.
   */
  setVerifier(which: "real" | "stand-in"): Promise<void>;
  /**
   * Asks the Worker's proof verifier (src/in-worker.ts) through the test
   * build's `POST /__test/verify`: true if the proof is accepted.
   */
  verify(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): Promise<boolean>;
  /**
   * The object of a proof log that was cleared: one the settings named before
   * they were given another name (README.md, "清空測試的證明紀錄"). No request
   * reaches it any more; it is still there, with what it stored.
   */
  clearedProofLog(name: string): {
    /** Stops the running object, as a deploy does: it starts again when its alarm rings. */
    restart(): Promise<void>;
    /** Runs the object's alarm now, as when it rings by itself (test build, `POST /__test/proof-log/alarm?object=`). */
    runAlarm(): Promise<void>;
    /** Whether the object has an alarm set (test build, `GET /__test/proof-log/alarm?object=`). Asking starts an object that is not running. */
    hasAlarm(): Promise<boolean>;
  };
  /** The proof log's Durable Object, beyond what the API shows of it. */
  readonly proofLog: {
    /**
     * Stops the running object; the next request starts it again from what
     * it stored. Whatever it held only in memory is gone.
     */
    restart(): Promise<void>;
    /** Runs the object's alarm now, whatever time it is set for (test build, `POST /__test/proof-log/alarm`). */
    runAlarm(): Promise<void>;
    /** How many milliseconds from now the object's alarm is set for, or null if it has none (test build, `GET /__test/proof-log/alarm`). */
    alarmInMs(): Promise<number | null>;
    /**
     * Gives the object a second piece of timed work next to its own: due at
     * `due` on the object's clock, and after each run due again `everyMs`
     * later (test build, `PUT /__test/proof-log/extra-work`). It is kept in
     * memory: gone when the object starts again.
     */
    setExtraWork(due: Date, everyMs: number): Promise<void>;
    /** The times, on the object's clock, at which that second piece ran. */
    extraWorkRuns(): Promise<Date[]>;
    /**
     * Changes the version the object's tables say they were made by: to
     * another one than the build's, or back (test build,
     * `PUT /__test/proof-log/schema-version`). The object compares when it
     * starts: `restart()` after this.
     */
    setStoredSchemaVersion(to: "another" | "the build's"): Promise<void>;
    /**
     * Changes the version of the record rules the object's stored state
     * says it was computed by: to another one than the build's, or back
     * (test build, `PUT /__test/proof-log/rules-version`). The object compares
     * when it starts: `restart()` after this.
     */
    setStoredRulesVersion(to: "another" | "the build's"): Promise<void>;
    /**
     * From now on every write of the object to this table fails (or, for
     * `challenges.accepted`, only marking a challenge as accepted), or, with
     * null, none does (test build, `PUT /__test/proof-log/fail-writes`).
     */
    failWritesTo(what: "records" | "cards" | "proof_log" | "challenges" | "challenges.accepted" | "view_cards" | "view_ordinals" | "view_slots" | "view_history" | "view_state" | null): Promise<void>;
    /**
     * Every row of the views the object keeps for the pages (src/views.ts),
     * table by table (test build, `GET /__test/proof-log/views`): for the one
     * thing no page can show, that the views written again from the records
     * are row for row the views written record by record.
     */
    views(): Promise<StoredViews>;
    /**
     * The plan SQLite makes for each statement the pages' reads run, and the
     * count of the cards of an account a submission's answer reads, each
     * asked for what the question gives (test build, `POST
     * /__test/proof-log/page-plans`).
     */
    pagePlans(question: PagePlanQuestion): Promise<PagePlans>;
    /**
     * Clears the views (test build, `DELETE /__test/proof-log/views`): the
     * object is then as one that has records from before it had the views.
     * It fills them from its records when it starts: `restart()` after this.
     */
    clearViews(): Promise<void>;
    /**
     * Empties `view_ordinals` alone (test build, `DELETE
     * /__test/proof-log/view-ordinals`): the object is then as one whose
     * views were filled before that table was one. `restart()` after this.
     */
    forgetOrdinals(): Promise<void>;
    /**
     * Waits until the object that is running has filled its views, or has
     * given up filling them (test build, `POST /__test/proof-log/views-filled`):
     * an object that has log files in the data bucket fills them after
     * it has started, while it already answers.
     */
    viewsFilled(): Promise<void>;
    /**
     * Runs the record rules for one event of spec/vectors/record-rules.json
     * on the state the object stores, keeps what a valid one leaves, and
     * returns the result (test build, `POST /__test/proof-log/rule-event`).
     */
    applyRuleEvent(event: RuleEvent): Promise<{ valid: boolean; reason?: string; kinds?: { platform: string; kind: string }[] }>;
    /**
     * The latest valid date the record rules read for a card, and the cards
     * of every declared account of its scope as the object counts them
     * (test build, `POST /__test/proof-log/rule-state`).
     */
    ruleState(scopeString: string, scopedId: string): Promise<RuleStateAnswer>;
    /**
     * Of the challenges `POST /api/v1/challenges` has given out through
     * `fetch` or `issueChallenge` since this worker started, the ones the
     * back end still takes a submission for, sorted. It asks the API: for
     * each, a `POST /api/v1/records` with that challenge and a proof that
     * does not verify, which is `challenge_unknown` for a challenge the back
     * end does not know (never issued by this proof log, expired, deleted) and
     * `proof` or `challenge_attempts` for one it knows. Each question counts
     * as a submission of the challenge.
     */
    knownChallenges(): Promise<string[]>;
    /**
     * Writes a row of the card state table as it is given (test build,
     * `PUT /__test/proof-log/card`): for the stored states no request to this
     * build can leave, a broken one or one from before a platform was added.
     */
    writeCard(card: CardToWrite): Promise<void>;
    /** Writes rows of the card state table as they are given, in one transaction (test build, `PUT /__test/proof-log/cards`): how a measurement fills it with many cards. */
    writeCards(cards: readonly CardToWrite[]): Promise<void>;
    /**
     * "copy": copies the card state table as a publication does; "drop":
     * drops the copy (test build, `POST /__test/proof-log/cards-copy`). How a
     * measurement times either alone.
     */
    cardsCopy(what: "copy" | "drop"): Promise<void>;
    /**
     * Makes the stored slots of one card of the test log text that is
     * not JSON (test build, `POST /__test/proof-log/break-card`): what reads
     * that row then fails, `card-state` for the card and whatever looks at
     * every card of its scope. `mendCard` puts the slots back as they
     * were.
     */
    breakCard(scopedId: string): Promise<void>;
    mendCard(scopedId: string): Promise<void>;
    /** Drops the tables the API reads, so that the back end itself fails (test build, `POST /__test/proof-log/break`). */
    breakTables(): Promise<void>;
    /**
     * Drops the table of the newest CRLs (test build,
     * `POST /__test/proof-log/drop-newest-crls`): the object is then as one
     * made by a build that did not have that table yet. `restart()` after
     * this.
     */
    dropNewestCrls(): Promise<void>;
    /**
     * The rows the object keeps of its records, in the order of `seq`, and
     * the count and the proof log fingerprint of its row of the proof log (test
     * build, `GET /__test/proof-log/stored`). `checkProofLog` of test/records.ts
     * is what checks them.
     */
    stored(): Promise<StoredProofLog>;
    /**
     * How many records the object keeps, and the first and the last `seq`
     * among them (test build, `GET /__test/proof-log/kept`): for a proof log
     * that keeps more than `stored()` can answer with, which is some 1,600
     * records (test-build/card-door.ts, `KeptRecords`, says what is known
     * of that limit).
     */
    kept(): Promise<KeptRecords>;
    /** The names of the tables of the object's SQLite, in byte order (test build, `GET /__test/proof-log/tables`). */
    tables(): Promise<string[]>;
    /**
     * Begins the rebuild from the proof log named `token` (src/rebuild.ts;
     * test build, `POST /__test/proof-log/rebuild`); whether one was begun: not
     * if the last one the object began has that name. Its steps are the
     * alarm's: `runAlarm()` makes one.
     */
    beginRebuild(token: string): Promise<boolean>;
    /**
     * From now on the object's alarm does its work only when the test runs
     * it (`runAlarm`), or, with false, also when it rings by itself (test
     * build, `PUT /__test/proof-log/alarm-held`). Kept with the object: it
     * holds across `restart()`, and a new object starts without it.
     */
    holdAlarm(hold: boolean): Promise<void>;
    /** What the object knows of the last rebuild it began, or null (test build, `GET /__test/proof-log/rebuild`). */
    rebuildStatus(): Promise<{ token: string; status: "running" | "swapped" | "refused"; records: number; reason: string | null } | null>;
    /**
     * From now on the object waits this many milliseconds before it hashes
     * a record it is asked to write (test build,
     * `PUT /__test/proof-log/hash-delay`): other requests run during the wait,
     * which they do not during the hash itself in the local workerd. Kept
     * in memory: gone when the object starts again.
     */
    setHashDelay(ms: number): Promise<void>;
    /** How many times the object has hashed a record since it started: more than the submissions it was asked to write, if any was hashed again for another `seq`. */
    hashes(): Promise<number>;
    /**
     * From now on the object's writes or reads of one object of the data
     * bucket go wrong in one way, or, with null, none does (test build,
     * `PUT /__test/proof-log/bucket-fault`). Kept in memory: gone when the
     * object starts again.
     */
    setBucketFault(fault: BucketFault): Promise<void>;
  };
  close(): Promise<void>;
}

export type { BucketFault, CardToWrite, KeptRecords, RuleEvent, RuleStateAnswer, StoredProofLog, StoredViews, TestSettings };

/**
 * The name of the proof log's object in the test environment (wrangler.jsonc,
 * `PROOF_LOG_OBJECT_NAME`), read from the file: clearing the test log
 * changes it there (README.md, "清空測試的證明紀錄"), and nothing here.
 */
const DEPLOYED_PROOF_LOG_OBJECT = String(unstable_readConfig({ config: join(WORKER_DIR, "wrangler.jsonc"), env: "test" }, { hideWarnings: true }).vars.PROOF_LOG_OBJECT_NAME);

export interface StartOptions {
  /** How long the mirror waits for the fake MOICA, in milliseconds. The deployed build waits minutes (src/target.ts). */
  readonly crlTimeoutMs?: number;
  /**
   * Settings of the environment to start with in place of wrangler.jsonc's:
   * which proof log (`PROOF_LOG_KIND`) and the name of its object
   * (`PROOF_LOG_OBJECT_NAME`). The configuration file is not changed. With a
   * production log the files of Static Assets get the headers of a
   * production log's site (scripts/site-files.ts): those are fixed when
   * the Worker starts, and `setSettings` does not change them.
   */
  readonly settings?: TestSettings;
  /** For how long a round goes on starting files an earlier round left without a line, in milliseconds. By default the deployed build's (src/round-budget.ts). */
  readonly crlCatchUpMs?: number;
  /** The issuer keys of the build, one G2 and one G3. By default the test's own, which sign the CRLs of test/crls.ts. */
  readonly issuers?: readonly IssuerKey[];
  /**
   * A directory whose files Static Assets serves as the card proof page
   * (/proof is its index.html, /proof/… the rest): a build of web/, or
   * files a test made up. By default there is none, as in a deploy made
   * before web/ is built for it.
   */
  readonly proofFiles?: string;
}

/** Builds the test build and starts it in the local workerd, with a fake MOICA that has no CRL yet. */
export async function startWorker(options: StartOptions = {}): Promise<TestWorker> {
  const moica = await FakeMoica.start();
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "worker-"));
  // The Worker runs from a copy of wrangler.jsonc, byte for byte, in a directory of this test's own: the
  // configuration is the deployed one, and "assets.directory" (./site) is then this test's, so that tests
  // running at once do not share the card proof page's files. The files of site/ in the repository (the style
  // sheet) are copied as they are.
  const run = mkdtempSync(join(WORKER_DIR, "test-output", "run-"));
  copyFileSync(join(WORKER_DIR, "wrangler.jsonc"), join(run, "wrangler.jsonc"));
  cpSync(join(WORKER_DIR, "site"), join(run, "site"), { recursive: true, filter: (source) => source !== join(WORKER_DIR, "site", "proof") });
  if (options.proofFiles !== undefined) cpSync(options.proofFiles, join(run, "site", "proof"), { recursive: true });
  // site/_headers in the repository is a test log's site's; a production log's has its own.
  if (options.settings?.PROOF_LOG_KIND === "production") writeFileSync(join(run, "site", "_headers"), siteHeaders("production"));
  const server = createTestHarness({ root: run, workers: [{ configPath: "wrangler.jsonc", env: "test", prebuiltWorkerDir: dir }] });
  let url: URL;
  try {
    buildWorker("test", dir, { moica: moica.origin, issuers: options.issuers ?? testIssuers(), crlTimeoutMs: options.crlTimeoutMs ?? 2000, crlCatchUpMs: options.crlCatchUpMs ?? CRL_CATCH_UP_MS });
    ({ url } = await server.listen());
  } catch (e) {
    await moica.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(run, { recursive: true, force: true });
    throw e;
  }
  const worker = server.getWorker<{ DATA: Bucket }>();
  let settings: TestSettings = {};
  const proofLogObject = (): { name: string } => ({ name: settings.PROOF_LOG_OBJECT_NAME ?? DEPLOYED_PROOF_LOG_OBJECT });
  /** The objects the settings named before and no longer do, that `switchProofLog` has yet to start with settings that make them replaced ones. */
  const replaced = new Set<string>();
  const setSettings = async (next: TestSettings): Promise<void> => {
    const res = await server.fetch("/__test/settings", { method: "PUT", body: JSON.stringify(next) });
    if (res.status !== 204) throw new Error(`replacing the settings: HTTP ${res.status}`);
    replaced.add(proofLogObject().name);
    settings = next;
    replaced.delete(proofLogObject().name);
  };
  /** Every challenge `POST /api/v1/challenges` has given out through this object. */
  const issued: string[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const res = (await server.fetch(input, init as never)) as unknown as Response;
    if (res.status === 200 && init?.method === "POST" && input === "/api/v1/challenges") {
      const body = (await res.clone().json()) as { challenge?: unknown };
      if (typeof body.challenge === "string") issued.push(body.challenge);
    }
    return res;
  };
  if (options.settings !== undefined) await setSettings(options.settings);

  /** Runs the alarm of the object the settings name, or of the one named `name`; answers the HTTP status. */
  const alarmStatus = async (name: string | null): Promise<number> =>
    (await server.fetch(`/__test/proof-log/alarm${name === null ? "" : `?object=${encodeURIComponent(name)}`}`, { method: "POST" })).status;
  const runAlarmOf = async (name: string | null): Promise<void> => {
    const status = await alarmStatus(name);
    if (status !== 204) throw new Error(`running the alarm${name === null ? "" : ` of ${name}`}: HTTP ${status}`);
  };

  return {
    setSettings,
    async switchProofLog(next) {
      await setSettings(next);
      for (const name of [...replaced]) {
        try {
          await worker.evictDurableObject("PROOF_LOG" as never, { name });
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("not currently running"))) throw e;
        }
        // Its alarm, which then finds the object replaced and sets none: started now, not when the alarm would ring.
        // Also an object that was not running: it may still have an alarm set.
        // 500: the settings are ones no object starts with; it is started at the next switch.
        const status = await alarmStatus(name);
        if (status === 204) replaced.delete(name);
        else if (status !== 500) throw new Error(`running the alarm of ${name}: HTTP ${status}`);
      }
    },
    url,
    moica,
    fetch,
    runSchedule: () => worker.scheduled({ cron: HOURLY, scheduledTime: new Date() }),
    async files(prefix = "") {
      const { DATA } = await worker.getEnv();
      const keys: string[] = [];
      for (let cursor: string | undefined; ; ) {
        const page = await DATA.list({ prefix, ...(cursor !== undefined && { cursor }) });
        keys.push(...page.objects.map((o) => o.key));
        if (!page.truncated) break;
        cursor = page.cursor;
      }
      const out: StoredFile[] = [];
      for (const key of keys.sort()) {
        const object = await DATA.get(key);
        if (!object) throw new Error(`${key} was listed but is not there`);
        out.push({ key, bytes: new Uint8Array(await object.arrayBuffer()), cacheControl: object.httpMetadata?.cacheControl, contentType: object.httpMetadata?.contentType, uploaded: new Date(object.uploaded) });
      }
      return out;
    },
    async setClock(time) {
      const res = await server.fetch("/__test/clock", { method: "PUT", body: String(time.getTime()) });
      if (res.status !== 204) throw new Error(`setting the clock: HTTP ${res.status}`);
    },
    logLines: () => server.getLogs().map((l) => l.message),
    async seen() {
      const res = await server.fetch("/__test/seen");
      if (res.status !== 200) throw new Error(`asking what reached the Worker: HTTP ${res.status}`);
      return (await res.json()) as string[];
    },
    async issueChallenge(randomHex) {
      if (randomHex !== undefined) {
        const set = await server.fetch("/__test/proof-log/next-random", { method: "PUT", body: randomHex });
        if (set.status !== 204) throw new Error(`setting the next challenge's bytes: HTTP ${set.status}`);
      }
      const res = await fetch("/api/v1/challenges", { method: "POST" });
      if (res.status !== 200) throw new Error(`asking for a challenge: HTTP ${res.status} ${await res.text()}`);
      return ((await res.json()) as { challenge: string }).challenge;
    },
    async setVerifier(which) {
      const res = await server.fetch("/__test/verifier", { method: "PUT", body: which });
      if (res.status !== 204) throw new Error(`choosing the verifier: HTTP ${res.status}`);
    },
    async verify(circuit, proof, publicInputs) {
      const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
      const res = await server.fetch("/__test/verify", { method: "POST", body: JSON.stringify({ circuit, proof: hex(proof), publicInputs: publicInputs.map(hex) }) });
      if (res.status !== 200) throw new Error(`verifying: HTTP ${res.status} ${await res.text()}`);
      return ((await res.json()) as { verified: boolean }).verified;
    },
    async putFile(key, bytes, cacheControl, contentType) {
      await (await worker.getEnv()).DATA.put(key, bytes, { httpMetadata: { ...(cacheControl !== undefined && { cacheControl }), ...(contentType !== undefined && { contentType }) } });
    },
    async deleteFile(key) {
      await (await worker.getEnv()).DATA.delete(key);
    },
    async newestCrls() {
      const res = await server.fetch("/__test/newest-crls");
      if (res.status !== 200) throw new Error(`asking the proof log's object: HTTP ${res.status} ${await res.text()}`);
      return (await res.json()) as NewestCrls;
    },
    async restart() {
      await server.update((current) => ({ ...current }));
    },
    clearedProofLog: (name) => ({
      restart: () => worker.evictDurableObject("PROOF_LOG" as never, { name }),
      runAlarm: () => runAlarmOf(name),
      async hasAlarm() {
        const res = await server.fetch(`/__test/proof-log/alarm?object=${encodeURIComponent(name)}`);
        if (res.status !== 200) throw new Error(`reading the alarm of ${name}: HTTP ${res.status}`);
        return ((await res.json()) as { alarm: number | null }).alarm !== null;
      },
    }),
    proofLog: {
      restart: () => worker.evictDurableObject("PROOF_LOG" as never, proofLogObject()),
      async dropNewestCrls() {
        const res = await server.fetch("/__test/proof-log/drop-newest-crls", { method: "POST" });
        if (res.status !== 204) throw new Error(`dropping the table of the newest CRLs: HTTP ${res.status}`);
      },
      async setExtraWork(due, everyMs) {
        const res = await server.fetch("/__test/proof-log/extra-work", { method: "PUT", body: JSON.stringify({ due: due.getTime(), every: everyMs }) });
        if (res.status !== 204) throw new Error(`setting the extra work: HTTP ${res.status}`);
      },
      async extraWorkRuns() {
        const res = await server.fetch("/__test/proof-log/extra-work");
        if (res.status !== 200) throw new Error(`reading the extra work: HTTP ${res.status}`);
        return ((await res.json()) as { runs: number[] }).runs.map((ms) => new Date(ms));
      },
      runAlarm: () => runAlarmOf(null),
      async alarmInMs() {
        const res = await server.fetch("/__test/proof-log/alarm");
        if (res.status !== 200) throw new Error(`reading the alarm: HTTP ${res.status}`);
        const { alarm } = (await res.json()) as { alarm: number | null };
        return alarm === null ? null : alarm - Date.now();
      },
      async setStoredSchemaVersion(to) {
        const res = await server.fetch("/__test/proof-log/schema-version", { method: "PUT", body: JSON.stringify({ to }) });
        if (res.status !== 204) throw new Error(`changing the stored schema version: HTTP ${res.status}`);
      },
      async setStoredRulesVersion(to) {
        const res = await server.fetch("/__test/proof-log/rules-version", { method: "PUT", body: JSON.stringify({ to }) });
        if (res.status !== 204) throw new Error(`changing the stored rules version: HTTP ${res.status}`);
      },
      async failWritesTo(what) {
        const res = await server.fetch("/__test/proof-log/fail-writes", { method: "PUT", body: JSON.stringify({ what }) });
        if (res.status !== 204) throw new Error(`making writes fail: HTTP ${res.status} ${await res.text()}`);
      },
      async applyRuleEvent(event) {
        const res = await server.fetch("/__test/proof-log/rule-event", { method: "POST", body: JSON.stringify(event) });
        if (res.status !== 200) throw new Error(`applying a rule event: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as { valid: boolean; reason?: string; kinds?: { platform: string; kind: string }[] };
      },
      async knownChallenges() {
        const known: string[] = [];
        for (const challenge of issued) {
          const production = (settings.PROOF_LOG_KIND ?? "test") === "production";
          const body = {
            scope_string: production ? "iamreal:public:0_______________" : "iamreal-test:public:0__________",
            scoped_id: "0400000000000000000000000000000000000000000000000000",
            accounts: [],
            challenge,
            issuer: "G3",
            smt_root: "0".repeat(64),
            circuit: CIRCUITS.card_proof_rs4096.verificationKeySha256,
            // Placeholder bytes: no proof for the real verifier, and rejected by the stand-in (first byte 1).
            proof: Buffer.concat([Buffer.from([1]), Buffer.alloc(14655)]).toString("base64"),
          };
          const res = await server.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(body) });
          const { error } = (await res.json()) as { error?: string };
          if (error === "proof" || error === "challenge_attempts") known.push(challenge);
          else if (error !== "challenge_unknown") throw new Error(`asking whether a challenge is known: HTTP ${res.status} ${error}`);
        }
        return known.sort();
      },
      async writeCard(card) {
        const res = await server.fetch("/__test/proof-log/card", { method: "PUT", body: JSON.stringify(card) });
        if (res.status !== 204) throw new Error(`writing a card: HTTP ${res.status}`);
      },
      async writeCards(cards) {
        const res = await server.fetch("/__test/proof-log/cards", { method: "PUT", body: JSON.stringify(cards) });
        if (res.status !== 204) throw new Error(`writing cards: HTTP ${res.status}`);
      },
      async cardsCopy(what) {
        const res = await server.fetch("/__test/proof-log/cards-copy", { method: "POST", body: JSON.stringify({ what }) });
        if (res.status !== 204) throw new Error(`the copy of the card state table: HTTP ${res.status} ${await res.text()}`);
      },
      async ruleState(scopeString, scopedId) {
        const res = await server.fetch("/__test/proof-log/rule-state", { method: "POST", body: JSON.stringify({ scope_string: scopeString, scoped_id: scopedId }) });
        if (res.status !== 200) throw new Error(`reading the rule state: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as RuleStateAnswer;
      },
      async views() {
        const res = await server.fetch("/__test/proof-log/views");
        if (res.status !== 200) throw new Error(`reading the views: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as StoredViews;
      },
      async pagePlans(question) {
        const res = await server.fetch("/__test/proof-log/page-plans", { method: "POST", body: JSON.stringify(question) });
        if (res.status !== 200) throw new Error(`reading the plans of the pages' reads: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as PagePlans;
      },
      async viewsFilled() {
        const res = await server.fetch("/__test/proof-log/views-filled", { method: "POST" });
        if (res.status !== 204) throw new Error(`waiting for the views: HTTP ${res.status}`);
      },
      async clearViews() {
        const res = await server.fetch("/__test/proof-log/views", { method: "DELETE" });
        if (res.status !== 204) throw new Error(`clearing the views: HTTP ${res.status}`);
      },
      async forgetOrdinals() {
        const res = await server.fetch("/__test/proof-log/view-ordinals", { method: "DELETE" });
        if (res.status !== 204) throw new Error(`emptying view_ordinals: HTTP ${res.status}`);
      },
      async stored() {
        const res = await server.fetch("/__test/proof-log/stored");
        if (res.status !== 200) throw new Error(`reading the stored proof log: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as StoredProofLog;
      },
      async kept() {
        const res = await server.fetch("/__test/proof-log/kept");
        if (res.status !== 200) throw new Error(`reading what the proof log keeps: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as KeptRecords;
      },
      async beginRebuild(token) {
        const res = await server.fetch("/__test/proof-log/rebuild", { method: "POST", body: JSON.stringify({ token }) });
        if (res.status !== 200) throw new Error(`beginning a rebuild: HTTP ${res.status} ${await res.text()}`);
        return ((await res.json()) as { begun: boolean }).begun;
      },
      async holdAlarm(hold) {
        const res = await server.fetch("/__test/proof-log/alarm-held", { method: "PUT", body: String(hold) });
        if (res.status !== 204) throw new Error(`holding the alarm: HTTP ${res.status}`);
      },
      async rebuildStatus() {
        const res = await server.fetch("/__test/proof-log/rebuild");
        if (res.status !== 200) throw new Error(`reading the rebuild: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as Awaited<ReturnType<TestWorker["proofLog"]["rebuildStatus"]>>;
      },
      async tables() {
        const res = await server.fetch("/__test/proof-log/tables");
        if (res.status !== 200) throw new Error(`reading the object's tables: HTTP ${res.status} ${await res.text()}`);
        return (await res.json()) as string[];
      },
      async setHashDelay(ms) {
        const res = await server.fetch("/__test/proof-log/hash-delay", { method: "PUT", body: String(ms) });
        if (res.status !== 204) throw new Error(`setting the wait before a hash: HTTP ${res.status}`);
      },
      async hashes() {
        const res = await server.fetch("/__test/proof-log/hash-delay");
        if (res.status !== 200) throw new Error(`reading the number of hashes: HTTP ${res.status}`);
        return ((await res.json()) as { hashes: number }).hashes;
      },
      async setBucketFault(fault) {
        const res = await server.fetch("/__test/proof-log/bucket-fault", { method: "PUT", body: JSON.stringify(fault) });
        if (res.status !== 204) throw new Error(`setting the bucket's fault: HTTP ${res.status}`);
      },
      async breakCard(scopedId) {
        const res = await server.fetch("/__test/proof-log/break-card", { method: "POST", body: JSON.stringify({ scope_string: "iamreal-test:public:0__________", scoped_id: scopedId, mend: false }) });
        if (res.status !== 204) throw new Error(`breaking a card's row: HTTP ${res.status}`);
      },
      async mendCard(scopedId) {
        const res = await server.fetch("/__test/proof-log/break-card", { method: "POST", body: JSON.stringify({ scope_string: "iamreal-test:public:0__________", scoped_id: scopedId, mend: true }) });
        if (res.status !== 204) throw new Error(`mending a card's row: HTTP ${res.status}`);
      },
      async breakTables() {
        const res = await server.fetch("/__test/proof-log/break", { method: "POST" });
        if (res.status !== 204) throw new Error(`breaking the tables: HTTP ${res.status}`);
      },
    },
    async close() {
      await server.close();
      await moica.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(run, { recursive: true, force: true });
    },
  };
}
