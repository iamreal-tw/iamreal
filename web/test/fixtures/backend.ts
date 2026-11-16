// A fake server that answers as docs/api/card-proof.md says, and logs every
// request it gets. Tests change one answer at a time to something the device
// must not accept, then check that the device stopped and that no request
// carried the reason. Used in Node (as a fetch) and by the headless browser
// test's HTTP server.
import { sha256Hex } from "../../src/bytes.ts";
import { encodeBase32 } from "../../src/spec/base32.ts";
import { formatDay, taiwanDay } from "../../src/spec/date.ts";

export interface LoggedRequest {
  method: string;
  path: string;
  body: string;
}

export interface BackendOptions {
  /** Static files by path: the mirror (/crl/...), circuits, CRS. */
  files: Map<string, Uint8Array>;
  clock: () => number;
  /** The challenge to issue; by default today's date and 16 random bytes. */
  challenge?: () => unknown;
  crlMaxAgeDays?: unknown;
  cardState?: Record<string, unknown>;
  /** The answer to a submission; by default 201 `first`. */
  submit?: (body: Record<string, unknown>) => { status: number; body: unknown };
}

export interface Answer {
  status: number;
  type: string;
  bytes: Uint8Array;
}

export class FakeBackend {
  readonly log: LoggedRequest[] = [];
  readonly submissions: Record<string, unknown>[] = [];
  readonly opts: BackendOptions;

  constructor(opts: BackendOptions) {
    this.opts = opts;
  }

  private json(status: number, body: unknown): Answer {
    return { status, type: "application/json", bytes: new TextEncoder().encode(JSON.stringify(body)) };
  }

  async handle(method: string, path: string, body: string): Promise<Answer> {
    this.log.push({ method, path, body });
    const o = this.opts;
    if (method === "GET" && o.files.has(path)) {
      const type = path.endsWith(".json") ? "application/json" : "application/octet-stream";
      return { status: 200, type, bytes: o.files.get(path)! };
    }
    if (method === "GET" && path === "/api/v1/config") return this.json(200, { crl_max_age_days: o.crlMaxAgeDays ?? 3 });
    if (method === "POST" && path === "/api/v1/challenges") {
      const c = o.challenge ? o.challenge() : `${formatDay(taiwanDay(o.clock()))}.${encodeBase32(crypto.getRandomValues(new Uint8Array(16)))}`;
      return this.json(200, { challenge: c });
    }
    if (method === "POST" && path === "/api/v1/card-state") {
      return this.json(200, o.cardState ?? { current: null, last_declared: null, last_card_proof: null, proofs_on_last_date: 0, switch_dates: [], count: 0, head: "0".repeat(64) });
    }
    if (method === "POST" && path === "/api/v1/records") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      this.submissions.push(parsed);
      if (o.submit) {
        const r = o.submit(parsed);
        return this.json(r.status, r.body);
      }
      return this.json(201, { seq: this.submissions.length, record_hash: await sha256Hex(new TextEncoder().encode(body)), kind: "first", account_cards: 1 });
    }
    return this.json(404, { error: "not_found" });
  }

  /** The device's fetch, answered by this backend. */
  fetch = async (path: string, init?: { method: "GET" | "POST"; body?: string }): Promise<Response> => {
    const a = await this.handle(init?.method ?? "GET", path, init?.body ?? "");
    return new Response(a.bytes as BodyInit, { status: a.status, headers: { "Content-Type": a.type } });
  };
}
