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
import { type TestIssuer, WORKER_DIR, buildWorker } from "./build.ts";

/** The cron expression of the test environment (wrangler.jsonc). */
export const HOURLY = "0 * * * *";

export type IssuerName = "G2" | "G3";

/** The path of each issuer's CRL on the fake MOICA (test-build/target.ts). */
const CRL_PATHS: Readonly<Record<IssuerName, string>> = { G2: "/g2/complete.crl", G3: "/g3/complete.crl" };

/** One request the fake MOICA received. */
export interface MoicaRequest {
  readonly issuer: IssuerName | undefined;
  readonly path: string;
  readonly userAgent: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** A local server in MOICA's place: one CRL per issuer key, or an error status. */
export class FakeMoica {
  readonly origin: string;
  readonly requests: MoicaRequest[] = [];
  readonly #server: Server;
  readonly #answers = new Map<string, Uint8Array | number>();

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
      const issuer = (Object.keys(CRL_PATHS) as IssuerName[]).find((i) => CRL_PATHS[i] === path);
      moica.requests.push({ issuer, path, userAgent: req.headers["user-agent"], headers: req.headers });
      const answer = moica.#answers.get(path);
      if (answer === undefined) return void res.writeHead(404).end();
      if (typeof answer === "number") return void res.writeHead(answer).end("error");
      res.writeHead(200, { "Content-Type": "application/pkix-crl" }).end(answer);
    });
    return moica;
  }

  /** From now on this issuer's address gives these bytes. */
  serve(issuer: IssuerName, body: Uint8Array): void {
    this.#answers.set(CRL_PATHS[issuer], body);
  }

  /** From now on this issuer's address answers with this HTTP status. */
  fail(issuer: IssuerName, status: number): void {
    this.#answers.set(CRL_PATHS[issuer], status);
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
  /** What the Worker has written to its log since it started. */
  logLines(): string[];
  close(): Promise<void>;
}

let issuers: TestIssuer[] | undefined;

/**
 * The test's issuer keys: made on the spot, once per process, and the
 * private halves are dropped here (ADR-0028).
 */
export function testIssuers(): TestIssuer[] {
  issuers ??= ([["G2", 2048], ["G3", 4096]] as const).map(([name, bits]) => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 65537 });
    const n = publicKey.export({ format: "jwk" }).n!;
    return { name, modulus: Buffer.from(n, "base64url").toString("hex"), bits };
  });
  return issuers;
}

/** Builds the test build and starts it in the local workerd, with a fake MOICA that has no CRL yet. */
export async function startWorker(): Promise<TestWorker> {
  const moica = await FakeMoica.start();
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "worker-"));
  const server = createTestHarness({ root: WORKER_DIR, workers: [{ configPath: "wrangler.jsonc", env: "test", prebuiltWorkerDir: dir }] });
  let url: URL;
  try {
    buildWorker("test", dir, { moica: moica.origin, issuers: testIssuers() });
    ({ url } = await server.listen());
  } catch (e) {
    await moica.close();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const worker = server.getWorker<{ DATA: Bucket }>();

  return {
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
    async close() {
      await server.close();
      await moica.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
