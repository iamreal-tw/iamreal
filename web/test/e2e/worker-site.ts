// The back end of the headless browser tests, and of the apps' card proof
// tests (test/app-backend.ts): the Worker (worker/) in the local workerd,
// its test build (worker/test/harness.ts: the test's issuer keys, a fake
// MOICA, a clock the test sets), and in front of it a small server in the
// place of the data domain.
//
// On this computer and in CI there is no data domain. The Worker writes the
// CRL archive and the proof log's files to a simulated R2 bucket and has no
// route that sends a file of it (ADR-0027: those downloads do not run the
// back end). The test build of the page takes the data domain's files from
// its own origin (test/e2e/target.ts, DATA_ORIGIN), so the server here
// answers /crl/… and /proof-log/… from the bucket, read-only, and hands every
// other request to the Worker as it is. A test that serves a page of its
// own (the engine's test page, run.ts) or has paths of its own (the apps'
// clock and the maintainer's stop, app-backend.ts) answers those requests
// before either (`own`).
//
// The Worker's test clock shows the time it was last set to and does not
// run. `setClockAhead` has the server set it, before every request it hands
// to the Worker, to the machine's time plus a number of milliseconds: the
// back end's clock then runs that far ahead of the machine's, as a page's
// does whose Date.now a test moved by the same amount.
//
// Nothing here is real: no request leaves this computer, and none goes to
// MOICA or to MOICA's component.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type StartOptions, type TestWorker, startWorker } from "../../../worker/test/harness.ts";

export type { TestWorker };

/** The paths of the data domain (docs/api/card-proof.md, "Public files"): the CRL archive and the log directory. */
const DATA_PATHS = /^\/(crl|proof-log)\//;

const DATA_TYPES: Readonly<Record<string, string>> = { jsonl: "application/jsonl", crl: "application/pkix-crl", txt: "text/plain" };

export interface WorkerSite {
  /** The Worker behind the server: its clock, its schedule, its fake MOICA, the files of its bucket. */
  readonly worker: TestWorker;
  /** The server's origin, `http://localhost:<port>`: what the browser opens. */
  readonly origin: string;
  /** The method and path of every request the server handed to the Worker that the Worker answered 404, in order. */
  readonly notFound: string[];
  /** Every answer of the API with a status of 400 or more, in order: its path, status, `error` code and `X-Request-Id`. */
  readonly refusals: { readonly path: string; readonly status: number; readonly error: string | undefined; readonly requestId: string | null }[];
  /**
   * From now on the Worker's clock runs `ms` milliseconds ahead of the
   * machine's: set now, and again before every request handed to the
   * Worker (a Worker that was restarted has it again with the next one).
   */
  setClockAhead(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerSiteOptions extends StartOptions {
  /**
   * Answers a request before the data domain's files and the Worker are
   * asked, and returns true; or returns false and leaves it to them.
   */
  readonly own?: (req: IncomingMessage, res: ServerResponse, path: string) => boolean | Promise<boolean>;
}

/** Starts the Worker's test build and the server in front of it. */
export async function startWorkerSite(options: WorkerSiteOptions = {}): Promise<WorkerSite> {
  const { own, ...start } = options;
  const worker = await startWorker(start);
  const notFound: string[] = [];
  const refusals: { path: string; status: number; error: string | undefined; requestId: string | null }[] = [];
  let ahead: number | null = null;
  const syncClock = async (): Promise<void> => {
    if (ahead !== null) await worker.setClock(new Date(Date.now() + ahead));
  };
  const server: Server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0]!;
      if (own !== undefined && (await own(req, res, path))) return;
      // In the place of the data domain: the bucket's files, read-only.
      if (DATA_PATHS.test(path)) {
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
        const key = decodeURIComponent(path.slice(1));
        const file = (await worker.files(key)).find((f) => f.key === key);
        if (file === undefined) return void res.writeHead(404).end();
        return void res.writeHead(200, { "Content-Type": DATA_TYPES[key.split(".").pop() ?? ""] ?? "application/octet-stream", "Cache-Control": "no-store" }).end(req.method === "HEAD" ? undefined : Buffer.from(file.bytes));
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
      await syncClock();
      const answer = await worker.fetch(req.url ?? "/", { method: req.method, headers, redirect: "manual", ...(chunks.length > 0 && { body: Buffer.concat(chunks) }) });
      if (answer.status === 404) notFound.push(`${req.method} ${path}`);
      const body = Buffer.from(await answer.arrayBuffer());
      if (path.startsWith("/api/") && answer.status >= 400) {
        let error: string | undefined;
        try {
          error = (JSON.parse(body.toString("utf8")) as { error?: string }).error;
        } catch {
          // An answer that is not JSON has no code.
        }
        refusals.push({ path, status: answer.status, error, requestId: answer.headers.get("x-request-id") });
      }
      const out: Record<string, string> = {};
      answer.headers.forEach((value, key) => {
        // The body is sent as this server has it, not as the local workerd encoded it.
        if (!["content-encoding", "mf-content-encoding", "transfer-encoding", "content-length", "connection"].includes(key)) out[key] = value;
      });
      res.writeHead(answer.status, out).end(body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(e));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  } catch (e) {
    await worker.close();
    throw e;
  }
  return {
    worker,
    origin: `http://localhost:${(server.address() as AddressInfo).port}`,
    notFound,
    refusals,
    async setClockAhead(ms) {
      ahead = ms;
      await syncClock();
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await worker.close();
    },
  };
}
