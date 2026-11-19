// The Worker (ADR-0023). So far: the hourly CRL mirror and the roster's
// Durable Object as an empty class. It has no page and no API yet.
import { CRL_SOURCES, CRL_TIMEOUT_MS, ISSUERS, now } from "#target";
import { checkIssuerTable } from "./issuers.ts";
import { mirrorCrls } from "./mirror.ts";

export { Roster } from "./roster.ts";

// A build whose issuer keys are not one G2 and one G3 key does not start.
checkIssuerTable(ISSUERS);

export default {
  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response(null, { status: 404 });
  },

  /** The hourly schedule (wrangler.jsonc, "triggers"). */
  async scheduled(_controller, env): Promise<void> {
    const results = await mirrorCrls(CRL_SOURCES, env.DATA, CRL_TIMEOUT_MS);
    const at = now().toISOString();
    // One line per source, in the live log only: nothing here is kept.
    for (const r of results) console.log(JSON.stringify({ event: "crl_mirror", at, ...r }));
    const failed = results.filter((r) => r.result === "failed");
    // Thrown after every source was asked, so that the run shows as failed.
    if (failed.length > 0) throw new Error(`CRL mirror: ${failed.map((r) => r.issuer).join(", ")} failed`);
  },
} satisfies ExportedHandler<Env>;
