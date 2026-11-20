// The tool every test of the back end uses: the whole Worker in the local
// workerd, built with the test build (test/build.ts), next to a fake MOICA.
// A test sends it HTTP requests, runs its schedule, reads the files it wrote
// to the simulated R2 bucket, and sets its clock. Nothing here needs a
// Cloudflare account, and nothing sends a request to MOICA.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createTestHarness } from "wrangler";
import type { NewestCrls } from "../src/crl-index.ts";
import type { IssuerKey, IssuerName } from "../src/issuers.ts";
import { TEST_CRL_PATHS } from "../test-build/crl-paths.ts";
import { WORKER_DIR, buildWorker } from "./build.ts";
import { testIssuers } from "./crls.ts";

export { testIssuers } from "./crls.ts";

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
  put(key: string, value: Uint8Array | string, options?: { httpMetadata?: { cacheControl?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
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
  /**
   * Puts a file into the simulated R2 bucket, or takes one out, behind the
   * Worker's back: how a test leaves the bucket as a round that broke off
   * would have left it.
   */
  putFile(key: string, bytes: Uint8Array | string): Promise<void>;
  deleteFile(key: string): Promise<void>;
  /**
   * What the roster's Durable Object knows of the CRL archive, through the
   * test build's `GET /__test/newest-crls`.
   */
  newestCrls(): Promise<NewestCrls>;
  /**
   * Stops the Worker and its Durable Objects and starts them again. What
   * they keep in storage and the bucket's files stay; what they held in
   * memory, the test clock included, is gone.
   */
  restart(): Promise<void>;
  /** From now on the Worker's clock shows `time`. */
  setClock(time: Date): Promise<void>;
  /** What the Worker has written to its log since it started. */
  logLines(): string[];
  /**
   * Asks the Worker's proof verifier (src/in-worker.ts) through the test
   * build's `POST /__test/verify`: true if the proof is accepted.
   */
  verify(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): Promise<boolean>;
  close(): Promise<void>;
}

export interface StartOptions {
  /** How long the mirror waits for the fake MOICA, in milliseconds. The deployed build waits minutes (src/target.ts). */
  readonly crlTimeoutMs?: number;
  /** The issuer keys of the build, one G2 and one G3. By default the test's own, which sign the CRLs of test/crls.ts. */
  readonly issuers?: readonly IssuerKey[];
}

/** Builds the test build and starts it in the local workerd, with a fake MOICA that has no CRL yet. */
export async function startWorker(options: StartOptions = {}): Promise<TestWorker> {
  const moica = await FakeMoica.start();
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "worker-"));
  const server = createTestHarness({ root: WORKER_DIR, workers: [{ configPath: "wrangler.jsonc", env: "test", prebuiltWorkerDir: dir }] });
  let url: URL;
  try {
    buildWorker("test", dir, { moica: moica.origin, issuers: options.issuers ?? testIssuers(), crlTimeoutMs: options.crlTimeoutMs ?? 2000 });
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
    async verify(circuit, proof, publicInputs) {
      const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
      const res = await server.fetch("/__test/verify", { method: "POST", body: JSON.stringify({ circuit, proof: hex(proof), publicInputs: publicInputs.map(hex) }) });
      if (res.status !== 200) throw new Error(`verifying: HTTP ${res.status} ${await res.text()}`);
      return ((await res.json()) as { verified: boolean }).verified;
    },
    async putFile(key, bytes) {
      await (await worker.getEnv()).DATA.put(key, bytes);
    },
    async deleteFile(key) {
      await (await worker.getEnv()).DATA.delete(key);
    },
    async newestCrls() {
      const res = await server.fetch("/__test/newest-crls");
      if (res.status !== 200) throw new Error(`asking the roster's object: HTTP ${res.status} ${await res.text()}`);
      return (await res.json()) as NewestCrls;
    },
    async restart() {
      await server.update((current) => ({ ...current }));
    },
    async close() {
      await server.close();
      await moica.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
