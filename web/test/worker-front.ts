// A small server in front of the Worker's test build (worker/test/harness.ts),
// in the place of the data domain: the Worker has no route that sends a file
// of the CRL archive (ADR-0027), so this server answers /crl/… from the
// simulated bucket, read-only, and hands every other request to the Worker
// as it is. Only in tests.
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestWorker } from "../../worker/test/harness.ts";

export interface Front {
  /** Where the server listens: `http://localhost:<port>`. */
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * A request the test answers itself, before the Worker sees it: the status
 * to answer with (no body), or undefined to hand the request on.
 */
export type Own = (req: IncomingMessage, body: Buffer) => Promise<number | undefined>;

export async function startFront(worker: TestWorker, own?: Own): Promise<Front> {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path.startsWith("/crl/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
        const file = (await worker.files(path.slice(1))).find((f) => f.key === path.slice(1));
        if (file === undefined) return void res.writeHead(404).end();
        return void res.writeHead(200, { "Content-Type": path.endsWith(".jsonl") ? "application/jsonl" : "application/pkix-crl", "Cache-Control": "no-store" }).end(Buffer.from(file.bytes));
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const status = await own?.(req, Buffer.concat(chunks));
      if (status !== undefined) return void res.writeHead(status).end();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
      const answer = await worker.fetch(req.url ?? "/", { method: req.method, headers, redirect: "manual", ...(chunks.length > 0 && { body: Buffer.concat(chunks) }) });
      const out: Record<string, string> = {};
      answer.headers.forEach((value, key) => {
        // The body is sent as this server has it, not as the local workerd encoded it.
        if (!["content-encoding", "mf-content-encoding", "transfer-encoding", "content-length", "connection"].includes(key)) out[key] = value;
      });
      res.writeHead(answer.status, out).end(Buffer.from(await answer.arrayBuffer()));
    } catch (e) {
      res.writeHead(502).end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://localhost:${(server.address() as AddressInfo).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
