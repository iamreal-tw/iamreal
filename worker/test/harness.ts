// The tool every test of the back end uses: the whole Worker in the local
// workerd, built with the test build (test/build.ts), next to a fake MOICA.
// A test sends it HTTP requests, runs its schedule, reads the files it wrote
// to the simulated R2 bucket, and sets its clock. Nothing here needs a
// Cloudflare account, and nothing sends a request to MOICA.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createTestHarness } from "wrangler";
import type { IssuerKey, IssuerName } from "../src/issuers.ts";
import type { CardToWrite, TestSettings } from "../test-build/card-door.ts";
import { TEST_CRL_PATHS } from "../test-build/crl-paths.ts";
import { WORKER_DIR, buildWorker } from "./build.ts";

/** The cron expression of the test environment (wrangler.jsonc). */
export const HOURLY = "0 * * * *";

/** What the fake MOICA does with a request for one issuer key's CRL. */
type Answer =
  | { readonly kind: "body"; readonly body: Uint8Array }
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
          return void res.writeHead(200, { ...type, "Content-Length": answer.body.length }).end(answer.body);
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
  serve(issuer: IssuerName, body: Uint8Array): void {
    this.#answers.set(TEST_CRL_PATHS[issuer], { kind: "body", body });
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
  readonly uploaded: Date;
}

/** What the tests use of an R2 bucket binding. */
interface Bucket {
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { cacheControl?: string }; uploaded: Date } | null>;
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
  /** From now on the Worker's clock shows `time`. */
  setClock(time: Date): Promise<void>;
  /**
   * From now on the environment has these settings in place of
   * wrangler.jsonc's (test build, `PUT /__test/settings`). A roster's object
   * that is running keeps the ones it started with until `roster.restart()`.
   */
  setSettings(settings: TestSettings): Promise<void>;
  /** What the Worker has written to its log since it started. */
  logLines(): string[];
  /**
   * Asks the Worker's proof verifier (src/in-worker.ts) through the test
   * build's `POST /__test/verify`: true if the proof is accepted.
   */
  verify(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): Promise<boolean>;
  /**
   * The Worker's Poseidon2 hash (src/in-worker.ts) of these field elements,
   * through the test build's `POST /__test/poseidon2`. Elements and hash
   * are 64 hex digits, big-endian. Rejects if the Worker refuses the inputs.
   */
  poseidon2(inputs: readonly string[]): Promise<string>;
  /** The roster's Durable Object, beyond what the API shows of it. */
  readonly roster: {
    /**
     * Stops the running object; the next request starts it again from what
     * it stored. Whatever it held only in memory is gone.
     */
    restart(): Promise<void>;
    /** Runs the object's alarm now, whatever time it is set for (test build, `POST /__test/roster/alarm`). */
    runAlarm(): Promise<void>;
    /** How many milliseconds from now the object's alarm is set for, or null if it has none (test build, `GET /__test/roster/alarm`). */
    alarmInMs(): Promise<number | null>;
    /**
     * Gives the object a second piece of timed work next to its own: due at
     * `due` on the object's clock, and after each run due again `everyMs`
     * later (test build, `PUT /__test/roster/extra-work`). It is kept in
     * memory: gone when the object starts again.
     */
    setExtraWork(due: Date, everyMs: number): Promise<void>;
    /** The times, on the object's clock, at which that second piece ran. */
    extraWorkRuns(): Promise<Date[]>;
    /**
     * The challenges the object still holds, read from its storage. A
     * stopgap: no endpoint shows yet whether a challenge is known. When
     * submitting a record does (`challenge_unknown`, #67), the tests ask
     * that and this goes.
     */
    storedChallenges(): Promise<string[]>;
    /**
     * Writes the state of a card as a valid record would leave it, with the
     * object's own code (test build, `PUT /__test/roster/card`). Until
     * submitting a record writes it (#67).
     */
    writeCard(card: CardToWrite): Promise<void>;
    /** Drops the tables the API reads, so that the back end itself fails (test build, `POST /__test/roster/break`). */
    breakTables(): Promise<void>;
  };
  close(): Promise<void>;
}

export type { CardToWrite, TestSettings };

/** The name of the roster's object in the test environment (wrangler.jsonc, `ROSTER_OBJECT_NAME`). */
const DEPLOYED_ROSTER_OBJECT = "test-1";

let issuers: IssuerKey[] | undefined;

/**
 * The test's issuer keys: made on the spot, once per process, and the
 * private halves are dropped here (ADR-0028).
 */
export function testIssuers(): IssuerKey[] {
  issuers ??= ([["G2", 2048], ["G3", 4096]] as const).map(([name, bits]) => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 65537 });
    const n = publicKey.export({ format: "jwk" }).n!;
    return { name, modulus: Buffer.from(n, "base64url").toString("hex"), bits };
  });
  return issuers;
}

export interface StartOptions {
  /** How long the mirror waits for the fake MOICA, in milliseconds. The deployed build waits minutes (src/target.ts). */
  readonly crlTimeoutMs?: number;
  /**
   * Settings of the environment to start with in place of wrangler.jsonc's:
   * which roster (`ROSTER_KIND`) and the name of its object
   * (`ROSTER_OBJECT_NAME`). The configuration file is not changed.
   */
  readonly settings?: TestSettings;
}

/** Builds the test build and starts it in the local workerd, with a fake MOICA that has no CRL yet. */
export async function startWorker(options: StartOptions = {}): Promise<TestWorker> {
  const moica = await FakeMoica.start();
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "worker-"));
  const server = createTestHarness({ root: WORKER_DIR, workers: [{ configPath: "wrangler.jsonc", env: "test", prebuiltWorkerDir: dir }] });
  let url: URL;
  try {
    buildWorker("test", dir, { moica: moica.origin, issuers: testIssuers(), crlTimeoutMs: options.crlTimeoutMs ?? 2000 });
    ({ url } = await server.listen());
  } catch (e) {
    await moica.close();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const worker = server.getWorker<{ DATA: Bucket }>();
  let settings: TestSettings = {};
  const setSettings = async (next: TestSettings): Promise<void> => {
    const res = await server.fetch("/__test/settings", { method: "PUT", body: JSON.stringify(next) });
    if (res.status !== 204) throw new Error(`replacing the settings: HTTP ${res.status}`);
    settings = next;
  };
  const rosterObject = (): { name: string } => ({ name: settings.ROSTER_OBJECT_NAME ?? DEPLOYED_ROSTER_OBJECT });
  if (options.settings !== undefined) await setSettings(options.settings);

  return {
    setSettings,
    url,
    moica,
    fetch: (input, init) => server.fetch(input, init as never) as unknown as Promise<Response>,
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
        out.push({ key, bytes: new Uint8Array(await object.arrayBuffer()), cacheControl: object.httpMetadata?.cacheControl, uploaded: new Date(object.uploaded) });
      }
      return out;
    },
    async setClock(time) {
      const res = await server.fetch("/__test/clock", { method: "PUT", body: String(time.getTime()) });
      if (res.status !== 204) throw new Error(`setting the clock: HTTP ${res.status}`);
    },
    logLines: () => server.getLogs().map((l) => l.message),
    async verify(circuit, proof, publicInputs) {
      const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
      const res = await server.fetch("/__test/verify", { method: "POST", body: JSON.stringify({ circuit, proof: hex(proof), publicInputs: publicInputs.map(hex) }) });
      if (res.status !== 200) throw new Error(`verifying: HTTP ${res.status} ${await res.text()}`);
      return ((await res.json()) as { verified: boolean }).verified;
    },
    async poseidon2(inputs) {
      const res = await server.fetch("/__test/poseidon2", { method: "POST", body: JSON.stringify({ inputs }) });
      if (res.status !== 200) throw new Error(`hashing: HTTP ${res.status} ${await res.text()}`);
      return ((await res.json()) as { hash: string }).hash;
    },
    roster: {
      restart: () => worker.evictDurableObject("ROSTER" as never, rosterObject()),
      async setExtraWork(due, everyMs) {
        const res = await server.fetch("/__test/roster/extra-work", { method: "PUT", body: JSON.stringify({ due: due.getTime(), every: everyMs }) });
        if (res.status !== 204) throw new Error(`setting the extra work: HTTP ${res.status}`);
      },
      async extraWorkRuns() {
        const res = await server.fetch("/__test/roster/extra-work");
        if (res.status !== 200) throw new Error(`reading the extra work: HTTP ${res.status}`);
        return ((await res.json()) as { runs: number[] }).runs.map((ms) => new Date(ms));
      },
      async runAlarm() {
        const res = await server.fetch("/__test/roster/alarm", { method: "POST" });
        if (res.status !== 204) throw new Error(`running the alarm: HTTP ${res.status}`);
      },
      async alarmInMs() {
        const res = await server.fetch("/__test/roster/alarm");
        if (res.status !== 200) throw new Error(`reading the alarm: HTTP ${res.status}`);
        const { alarm } = (await res.json()) as { alarm: number | null };
        return alarm === null ? null : alarm - Date.now();
      },
      async storedChallenges() {
        const storage = await worker.getDurableObjectStorage("ROSTER" as never, rosterObject());
        return (await storage.exec<{ challenge: string }>("SELECT challenge FROM challenges ORDER BY challenge")).map((row) => row.challenge);
      },
      async writeCard(card) {
        const res = await server.fetch("/__test/roster/card", { method: "PUT", body: JSON.stringify(card) });
        if (res.status !== 204) throw new Error(`writing a card: HTTP ${res.status}`);
      },
      async breakTables() {
        const res = await server.fetch("/__test/roster/break", { method: "POST" });
        if (res.status !== 204) throw new Error(`breaking the tables: HTTP ${res.status}`);
      },
    },
    async close() {
      await server.close();
      await moica.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
