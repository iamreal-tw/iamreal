// The Worker (ADR-0023). So far: the hourly CRL mirror, and the roster's
// Durable Object, which keeps what the mirror tells it. It has no page and
// no API yet.
import { CRL_CATCH_UP_MS, CRL_SOURCES, CRL_TIMEOUT_MS, ISSUERS, now } from "#target";
import { poseidon2Hash } from "./in-worker.ts";
import { checkIssuerTable } from "./issuers.ts";
import { type CrlMirror, crlMirrorInWorker } from "./mirror.ts";
import { rosterOf } from "./roster.ts";

export { Roster } from "./roster.ts";

// A build whose issuer keys are not one G2 and one G3 key does not start.
checkIssuerTable(ISSUERS);

export default {
  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response(null, { status: 404 });
  },

  /** The hourly schedule (wrangler.jsonc, "triggers"): one round of the CRL mirror. */
  async scheduled(_controller, env): Promise<void> {
    // The only place that says which mirror it is (src/mirror.ts, `CrlMirror`).
    const mirror: CrlMirror = crlMirrorInWorker({
      sources: CRL_SOURCES,
      bucket: env.DATA,
      timeoutMs: CRL_TIMEOUT_MS,
      catchUpMs: CRL_CATCH_UP_MS,
      issuers: ISSUERS,
      hash: poseidon2Hash,
      tell: async (newest) => {
        await rosterOf(env).setNewestCrls(newest);
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
  },
} satisfies ExportedHandler<Env>;
