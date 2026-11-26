// The Worker (ADR-0023). So far: the API of a card proof (api.ts), the
// hourly CRL mirror (mirror.ts), and the proof log's Durable Object
// (proof-log.ts), which writes the records and keeps what the mirror tells it,
// the visitors' pages and the card proof page (visitor.ts).
import { CRL_CATCH_UP_MS, CRL_SOURCES, CRL_TIMEOUT_MS, ISSUERS, now } from "#target";
import { type ApiParts, api, isApiPath } from "./api.ts";
import { poseidon2Hash, proofVerifier } from "./in-worker.ts";
import { checkIssuerTable } from "./issuers.ts";
import { OLDEST_KEY, isOverdue, oldestDay, oldestFile } from "./connection-log.ts";
import { COUNT_TOTALS_OLDEST_KEY, DAY_TOTALS_PREFIX, type TotalsProofLog, countTotals } from "./count-totals.ts";
import { COUNT_EVENTS_OLDEST_KEY, COUNT_EVENTS_PREFIX } from "./counts.ts";
import { type CrlMirror, crlMirrorInWorker } from "./mirror.ts";
import { pageDataOfProofLog } from "./page-data.ts";
import { proofLogOf } from "./proof-log.ts";
import { proofLogSettingsOf } from "./settings.ts";
import { type VisitorParts, visitor } from "./visitor.ts";

export { Counts } from "./counts.ts";
export { ProofLog } from "./proof-log.ts";

// A build whose issuer keys are not one G2 and one G3 key does not start.
checkIssuerTable(ISSUERS);

/** The only place that says which proof verifier it is (src/verify.ts, `ProofVerifier`): the one that runs in the Worker. */
const API_PARTS: ApiParts = { verifier: proofVerifier };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (isApiPath(new URL(request.url).pathname)) return api(request, env, API_PARTS, (work) => ctx.waitUntil(work));
    // The only place that says where the pages read the proof log from (src/page-data.ts, `PageData`): its Durable Object.
    const parts: VisitorParts = { pageData: pageDataOfProofLog(env) };
    return visitor(request, env, parts);
  },

  /**
   * The hourly schedule (wrangler.jsonc, "triggers"): the date of the
   * connection log's oldest entry is published (connection-log.ts), the
   * date of the oldest file of counts (counts.ts), and that of the earliest
   * day of the counts' totals (count-totals.ts), each by itself; then one
   * round of the CRL mirror, and then the counts' totals.
   */
  async scheduled(_controller, env): Promise<void> {
    // First, and by itself: the mirror's trouble is not this file's, nor the other way round. If the bucket
    // cannot be listed or the file cannot be written, the file keeps its earlier time, which is what a check
    // from outside sees; here it is one line in the live log.
    const time = now();
    // A bucket that does not answer must not keep the mirror waiting: half a minute, then it is this hour's trouble.
    const inTime = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("no answer in 30 s")), 30_000)))]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      const oldest = await inTime(oldestDay(env.CONNECTION_LOG));
      await inTime(env.DATA.put(OLDEST_KEY, oldestFile(time, oldest), { httpMetadata: { cacheControl: "public, max-age=60", contentType: "application/json" } }));
      // An entry older than any should be: the bucket's lifecycle rule is not deleting. Said here too; whoever
      // checks from outside reads the same from the file.
      if (isOverdue(oldest, time)) console.error(JSON.stringify({ event: "connection_log_overdue", oldest }));
    } catch (e) {
      console.error(JSON.stringify({ event: "connection_log_oldest_not_published", error: e instanceof Error ? e.name : "unknown" }));
    }
    // The same of the counts (counts.ts), which are in the same bucket under their own prefix, and with the
    // same 31 days: the same file, the same bound. By itself, so that neither's trouble is the other's.
    try {
      const oldest = await inTime(oldestDay(env.CONNECTION_LOG, COUNT_EVENTS_PREFIX));
      await inTime(env.DATA.put(COUNT_EVENTS_OLDEST_KEY, oldestFile(time, oldest), { httpMetadata: { cacheControl: "public, max-age=60", contentType: "application/json" } }));
      if (isOverdue(oldest, time)) console.error(JSON.stringify({ event: "count_events_overdue", oldest }));
    } catch (e) {
      console.error(JSON.stringify({ event: "count_events_oldest_not_published", error: e instanceof Error ? e.name : "unknown" }));
    }
    // The counts' totals are kept for good (count-totals.ts): the earliest day's must stay. The date of the
    // earliest is published the same way, and whoever checks from outside sees it move if a rule deleted it.
    try {
      const oldest = await inTime(oldestDay(env.CONNECTION_LOG, DAY_TOTALS_PREFIX));
      await inTime(env.DATA.put(COUNT_TOTALS_OLDEST_KEY, oldestFile(time, oldest), { httpMetadata: { cacheControl: "public, max-age=60", contentType: "application/json" } }));
    } catch (e) {
      console.error(JSON.stringify({ event: "count_totals_oldest_not_published", error: e instanceof Error ? e.name : "unknown" }));
    }

    // The mirror's trouble does not keep the totals from being made: it is thrown after them.
    let mirrorFailed: { error: unknown } | null = null;
    try {
      await mirrorRound(env);
    } catch (error) {
      mirrorFailed = { error };
    }
    // The counts' totals (count-totals.ts), after the mirror: the mirror's round counts its time from its start.
    try {
      // The settings are read where everything reads them, before the object is asked (settings.ts).
      proofLogSettingsOf(env);
      const proofLog = proofLogOf(env);
      const asked: TotalsProofLog = {
        knownShortIds: (ids, through) => proofLog.totalsKnownShortIds(ids, through),
        shortIdsThrough: (through) => proofLog.totalsShortIdsThrough(through),
        scopedIdsOf: (seqs) => proofLog.totalsScopedIds(seqs),
      };
      await countTotals(env.CONNECTION_LOG, asked, now());
    } catch (e) {
      console.error(JSON.stringify({ event: "count_totals_not_made", error: e instanceof Error ? e.name : "unknown" }));
    }
    if (mirrorFailed !== null) throw mirrorFailed.error;
  },
} satisfies ExportedHandler<Env>;

/** One round of the CRL mirror, with its lines in the live log. Throws if it failed, after everything that could be done was done. */
async function mirrorRound(env: Env): Promise<void> {
  // The only place that says which mirror it is (src/mirror.ts, `CrlMirror`).
  const mirror: CrlMirror = crlMirrorInWorker({
    sources: CRL_SOURCES,
    bucket: env.DATA,
    timeoutMs: CRL_TIMEOUT_MS,
    catchUpMs: CRL_CATCH_UP_MS,
    issuers: ISSUERS,
    hash: poseidon2Hash,
    tell: async (newest) => {
      // The settings are read where everything reads them, before the
      // object is asked: with settings that do not fit each other nothing
      // is told (settings.ts).
      proofLogSettingsOf(env);
      await proofLogOf(env).setNewestCrls(newest);
    },
  });
  const round = await mirror.round();
  const at = now().toISOString();
  // One line per source and one per file that was read, in the live log only: nothing here is kept.
  for (const r of round.sources) console.log(JSON.stringify({ event: "crl_mirror", at, ...r }));
  for (const f of round.files) {
    if (f.result === "failed") console.log(JSON.stringify({ event: "crl_index", at, ...f }));
    else {
      const { issuer, crlNumber, crlDate, sha256, root } = f.line;
      console.log(JSON.stringify({ event: "crl_index", at, result: f.result, sha256, issuer, crl_number: crlNumber, crl_date: crlDate, root, entries: f.entries, keys: f.keys, hashes: f.hashes, read_ms: f.readMs, tree_ms: f.treeMs }));
    }
  }
  // Thrown after everything that could be done was done, so that the run shows as failed.
  if (round.errors.length > 0) throw new Error(`CRL mirror: ${round.errors.join("; ")}`);
}
