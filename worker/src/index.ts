// The Worker (ADR-0023). So far: the API of a card proof (api.ts), the
// hourly CRL mirror (mirror.ts), and the proof log's Durable Object
// (proof-log.ts), which writes the records and keeps what the mirror tells it,
// the visitors' pages and the card proof page (visitor.ts), and the app
// domain's two files and page (app-domain.ts).
import { CRL_CATCH_UP_MS, CRL_SOURCES, CRL_TIMEOUT_MS, ISSUERS, now } from "#target";
import { type ApiParts, api, isApiPath } from "./api.ts";
import { appDomain, isAppDomainHost } from "./app-domain.ts";
import { poseidon2Hash, proofVerifier } from "./in-worker.ts";
import { checkIssuerTable } from "./issuers.ts";
import { CONNECTION_LOG_PREFIX, OLDEST_KEY, isOverdue, oldestDay, oldestFile } from "./connection-log.ts";
import { COUNT_TOTALS_OLDEST_KEY, DAY_TOTALS_PREFIX, type TotalsProofLog, countTotals } from "./count-totals.ts";
import { COUNT_EVENTS_OLDEST_KEY, COUNT_EVENTS_PREFIX } from "./counts.ts";
import { type CrlMirror, crlMirrorInWorker } from "./mirror.ts";
import { pageDataOfProofLog } from "./page-data.ts";
import { proofLogOf } from "./proof-log.ts";
import { proofLogSettingsOf } from "./settings.ts";
import { type VisitorParts, visitor } from "./visitor.ts";

export { Counts } from "./counts.ts";
export { ProofLog } from "./proof-log.ts";
export { Starts } from "./starts.ts";

// A build whose issuer keys are not one G2 and one G3 key does not start.
checkIssuerTable(ISSUERS);

/** The only place that says which proof verifier it is (src/verify.ts, `ProofVerifier`): the one that runs in the Worker. */
const API_PARTS: ApiParts = { verifier: proofVerifier };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // The app domain (src/app-domain.ts) before anything else: on it there is no API and no page of the site.
    if (isAppDomainHost(env, url.hostname)) return appDomain(request, env);
    if (isApiPath(url.pathname)) return api(request, env, API_PARTS, (work) => ctx.waitUntil(work));
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
    /**
     * Publishes the date of the oldest object under one prefix of the bucket that is not public, as the file
     * `key` of the public data. With `overdue`, a date older than any should be (the bucket's lifecycle rule
     * is not deleting) is said in the live log too; whoever checks from outside reads the same from the file.
     * By itself: one's trouble is not the others'.
     */
    const publishOldest = async (prefix: string, key: string, event: string, overdue: boolean): Promise<void> => {
      try {
        const oldest = await inTime(oldestDay(env.CONNECTION_LOG, prefix));
        await inTime(env.DATA.put(key, oldestFile(time, oldest), { httpMetadata: { cacheControl: "public, max-age=60", contentType: "application/json" } }));
        if (overdue && isOverdue(oldest, time)) console.error(JSON.stringify({ event: `${event}_overdue`, oldest }));
      } catch (e) {
        console.error(JSON.stringify({ event: `${event}_oldest_not_published`, error: e instanceof Error ? e.name : "unknown" }));
      }
    };
    await publishOldest(CONNECTION_LOG_PREFIX, OLDEST_KEY, "connection_log", true);
    // The counts (counts.ts) are in the same bucket under their own prefix, with the same 31 days: the same file, the same bound.
    await publishOldest(COUNT_EVENTS_PREFIX, COUNT_EVENTS_OLDEST_KEY, "count_events", true);
    // The counts' totals are kept for good (count-totals.ts): the earliest day's must stay, and whoever checks from
    // outside sees its date move if a rule deleted it. No bound.
    await publishOldest(DAY_TOTALS_PREFIX, COUNT_TOTALS_OLDEST_KEY, "count_totals", false);

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
  // One line per source, one per file that was read and one per patch, in the live log only: nothing here is kept.
  for (const r of round.sources) console.log(JSON.stringify({ event: "crl_mirror", at, ...r }));
  for (const f of round.files) {
    if (f.result === "failed") console.log(JSON.stringify({ event: "crl_index", at, ...f }));
    else {
      const { issuer, crlNumber, crlDate, sha256, root } = f.line;
      console.log(JSON.stringify({ event: "crl_index", at, result: f.result, sha256, issuer, crl_number: crlNumber, crl_date: crlDate, root, entries: f.entries, keys: f.keys, hashes: f.hashes, read_ms: f.readMs, tree_ms: f.treeMs }));
    }
  }
  for (const p of round.patches) console.log(JSON.stringify({ event: "crl_patch", at, ...p }));
  // Thrown after everything that could be done was done, so that the run shows as failed.
  if (round.errors.length > 0) throw new Error(`CRL mirror: ${round.errors.join("; ")}`);
}
