// The entry point of the measurement's build (measure/README.md): the
// deployed Worker of src/index.ts and its objects, and in front of it a few
// doors under /__measure/ for what the measurement must do that no request
// of the site can. It is deployed only as the temporary Worker of the
// measurement (measure/deploy.ts, which refuses any other name), with
// buckets of its own; never in the deployed build (test/bundle.test.ts,
// scripts/deploy-build-checks.ts, `NOT_DEPLOYED`).
//
// **It writes records whose proofs no one verified**: the door of the writes
// (`/__measure/write`) asks the proof log's object for a challenge, counts a
// submission and has the record accepted, as `POST /api/v1/records` does,
// without the verification between, and the made-up proof log (log.ts) has
// random bytes for proofs. That is what is measured: the object's side of a
// write, which the verification does not take part in (it runs in the
// Worker: README.md, "送出一筆"). No fake issuer key is in it (ADR-0028), and
// no record of it is written to the test log or the production one: its
// buckets and its object are the measurement's own, deleted afterwards.
//
// The doors open only with the key the maintainer made and set on the Worker
// themselves (the secret MEASURE_KEY, sent as `Authorization: Bearer <key>`).
// Without it, or with a key under 32 characters set, every /__measure/ path
// is the deployed Worker's (a 404). There is no schedule: the CRL mirror
// never runs here, so nothing is sent to MOICA.
//
//   POST /__measure/log-file      {before, fingerprint, day}: writes the made-up log file after `before` records
//   POST /__measure/fingerprints  {day, count, fingerprint}: writes the fingerprint file of one line
//   GET  /__measure/size          the object's database size, and the rows of each table
//   GET  /__measure/short-ids?n=  n short IDs of cards in the views, at random
//   POST /__measure/crls          gives the object one CRL of G3 dated today, of the made-up root
//   POST /__measure/write         one write of a made-up card, the object's side of it
//   POST /__measure/cards-copy?drop=0|1   copies the card state table as the publication does, or drops the copy
//   POST /__measure/publish-now   makes today's publication due and rings the alarm now
//   GET  /__measure/count-events?date=YYYY-MM-DD   for each minute file of the day: counts kept, dropped
import { formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import deployed from "../src/index.ts";
import { COUNT_EVENTS_PREFIX } from "../src/counts.ts";
import { copyCards, dropCardsCopy } from "../src/card-table.ts";
import { FINGERPRINT_FILE } from "../src/proof-log-files.ts";
import { ProofLog as DeployedProofLog, proofLogOf } from "../src/proof-log.ts";
import { fingerprintLine } from "iamreal-protocol/record.ts";
import { MEASURE_ROOT, madeUpFields, madeUpFingerprintFile, madeUpLogFile } from "./log.ts";

export { Counts, Starts } from "../src/index.ts";

/** The deployed proof log's object, and what the measurement reads of it and does to it. */
export class ProofLog extends DeployedProofLog {
  /**
   * The size of the object's SQLite database in bytes (`databaseSize`), how
   * many rows each of its tables has, and the bytes of what each table holds:
   * the sum of the length of every value, as a BLOB (SQLite's pages, indexes
   * and the record headers not counted; `dbstat`, which counts them, is not
   * there in the local workerd). Null if the columns cannot be read.
   */
  measureSize(): { database_bytes: number; tables: Record<string, number>; bytes: Record<string, number> | null } {
    const sql = this.ctx.storage.sql;
    const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").toArray().map((r) => r.name);
    const tables: Record<string, number> = {};
    for (const name of names) tables[name] = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).one().n;

    const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`;
    let bytes: Record<string, number> | null = {};
    try {
      for (const name of names) {
        const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", name).toArray().map((r) => `COALESCE(LENGTH(CAST(${quoted(r.name)} AS BLOB)), 0)`);
        bytes[name] = columns.length === 0 ? 0 : sql.exec<{ n: number | null }>(`SELECT SUM(${columns.join(" + ")}) AS n FROM ${quoted(name)}`).one().n ?? 0;
      }
    } catch {
      bytes = null;
    }
    return { database_bytes: sql.databaseSize, tables, bytes };
  }

  /** The copy of the card state table the daily publication makes (card-table.ts, `copyCards`), alone; `drop` drops it. */
  measureCardsCopy(drop: boolean): void {
    if (drop) dropCardsCopy(this.ctx.storage.sql);
    else copyCards(this.ctx.storage.sql);
  }

  /** `n` short IDs of cards the views have, at random. */
  measureShortIds(n: number): string[] {
    return this.ctx.storage.sql.exec<{ short_id: string }>("SELECT short_id FROM view_cards ORDER BY random() LIMIT ?", n).toArray().map((r) => r.short_id);
  }

  /**
   * Makes today's publication due as if the object had not published today:
   * today's line out of `published`, the first day yesterday, the bucket's
   * fingerprint file written from the lines left (so that it is the start of
   * the table again: README.md, "每天換日公布證明紀錄"), and the alarm now.
   */
  async measurePublishNow(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const today = taiwanDay(Date.now());
    sql.exec("DELETE FROM published WHERE date >= ?", formatDay(today));
    sql.exec("UPDATE first_day SET date = ? WHERE id = 1", formatDay(today - 1));
    const rows = sql.exec<{ date: string; count: number; fingerprint: string }>("SELECT date, count, fingerprint FROM published ORDER BY date").toArray();
    const text = rows.map((r) => fingerprintLine({ date: parseDay(r.date)!, count: r.count, fingerprint: r.fingerprint })).join("");
    await this.bucket().put(FINGERPRINT_FILE, text);
    await this.ctx.storage.setAlarm(Date.now());
  }
}

interface MeasureEnv extends Env {
  readonly MEASURE_KEY?: string;
}

const json = (value: unknown, status = 200): Response => new Response(`${JSON.stringify(value)}\n`, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** Whether the request carries the key the maintainer set: compared as SHA-256 digests, in constant time. */
async function opens(request: Request, env: MeasureEnv): Promise<boolean> {
  const key = env.MEASURE_KEY;
  const given = request.headers.get("Authorization");
  if (typeof key !== "string" || key.length < 32 || given === null) return false;
  const digest = async (s: string): Promise<ArrayBuffer> => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return crypto.subtle.timingSafeEqual(await digest(`Bearer ${key}`), await digest(given));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOfText = (text: unknown): number => {
  const day = typeof text === "string" ? parseDay(text) : null;
  if (day === null) throw new Error("day: YYYY-MM-DD");
  return day;
};

const fingerprintOf = (text: unknown): string => {
  if (typeof text !== "string" || !/^[0-9a-f]{64}$/.test(text)) throw new Error("fingerprint: 64 lowercase hex digits");
  return text;
};

async function door(request: Request, env: MeasureEnv, pathname: string, url: URL): Promise<Response | null> {
  const log = proofLogOf(env) as unknown as DurableObjectStub<ProofLog>;
  const body = async (): Promise<Record<string, unknown>> => (await request.json()) as Record<string, unknown>;
  switch (`${request.method} ${pathname}`) {
    case "POST /__measure/log-file": {
      // In the Worker, not the object: the object must not start before the files are there (it rebuilds when it starts).
      const b = await body();
      const file = await madeUpLogFile(Number(b["before"]), fingerprintOf(b["fingerprint"]), dayOfText(b["day"]));
      await env.DATA.put(file.key, file.text);
      return json({ key: file.key, bytes: new TextEncoder().encode(file.text).length, fingerprint: file.fingerprintAfter });
    }
    case "POST /__measure/fingerprints": {
      const b = await body();
      const count = b["count"];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("count: a number of records");
      const file = madeUpFingerprintFile(dayOfText(b["day"]), count, fingerprintOf(b["fingerprint"]));
      await env.DATA.put(file.key, file.text);
      return json({ key: file.key });
    }
    case "GET /__measure/size":
      return json(await log.measureSize());
    case "GET /__measure/short-ids":
      return json(await log.measureShortIds(Math.min(10_000, Math.max(1, Number(url.searchParams.get("n") ?? "100") || 100))));
    case "POST /__measure/crls": {
      const crl = { root: MEASURE_ROOT, crlNumber: "1", crlDate: formatDay(taiwanDay(Date.now())) };
      await log.setNewestCrls({ G2: [crl], G3: [crl] });
      return json({ ok: true });
    }
    case "POST /__measure/write": {
      const { challenge } = await log.issueChallenge();
      if (challenge === null) return json({ error: "paused" }, 503);
      const begun = await log.beginSubmission(challenge);
      if (begun !== "ok") return json({ error: begun }, 409);
      const answer = await log.accept(madeUpFields(challenge));
      return answer.outcome === "written" ? json({ seq: answer.record.seq }) : json({ error: answer.code }, 409);
    }
    case "POST /__measure/cards-copy":
      await log.measureCardsCopy(url.searchParams.get("drop") === "1");
      return json({ ok: true });
    case "POST /__measure/publish-now":
      await log.measurePublishNow();
      return json({ ok: true });
    case "GET /__measure/count-events": {
      const date = url.searchParams.get("date") ?? "";
      if (!DAY.test(date)) return json({ error: "date" }, 400);
      const minutes: { minute: string; counts: number; dropped: number }[] = [];
      for (let cursor: string | undefined; ; ) {
        const page = await env.CONNECTION_LOG.list({ prefix: `${COUNT_EVENTS_PREFIX}${date}/`, ...(cursor !== undefined && { cursor }) });
        for (const o of page.objects) {
          const object = await env.CONNECTION_LOG.get(o.key);
          if (object === null) continue;
          const file = (await object.json()) as { minute?: string; counts?: unknown[]; dropped?: number };
          if (typeof file.minute === "string") minutes.push({ minute: file.minute, counts: file.counts?.length ?? 0, dropped: file.dropped ?? 0 });
        }
        if (!page.truncated) break;
        cursor = page.cursor;
      }
      return json(minutes);
    }
    default:
      return null;
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__measure/") && (await opens(request, env))) {
      try {
        const answer = await door(request, env, url.pathname, url);
        if (answer !== null) return answer;
      } catch (e) {
        return json({ error: e instanceof Error ? `${e.name}: ${e.message}` : "unknown" }, 500);
      }
    }
    return deployed.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<MeasureEnv>;
