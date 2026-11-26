// The entry point of the build for a real card on this computer
// (scripts/local.ts, `pnpm local`): the deployed Worker of src/index.ts,
// whole (MOICA's issuer keys and CRL addresses, the proof verifier that runs
// in the Worker), and in front of it the one thing the data domain does on
// Cloudflare: send the files of the bucket. Never in the deployed build
// (test/bundle.test.ts).
//
// On Cloudflare the CRL archive and the proof log's files are sent by the
// bucket's own domain and the Worker has no route to them (ADR-0027). On this
// computer there is no such domain: the page of this build
// (web/src/target-local.ts) takes them from its own origin, so `GET` and
// `HEAD` of /crl/… and /proof-log/… are answered here from the simulated
// bucket, read-only, with the headers the object was written with. Every
// other request, and the schedule, is the deployed Worker's.
import deployed from "../src/index.ts";

export { Counts, ProofLog } from "../src/index.ts";

/** The paths of the data domain (docs/api/card-proof.md, "Public files"): the CRL archive and the log directory. */
const DATA_PATHS = /^\/(crl|proof-log)\/./;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (DATA_PATHS.test(pathname) && (request.method === "GET" || request.method === "HEAD")) {
      const object = await env.DATA.get(decodeURIComponent(pathname.slice(1)));
      if (object === null) return new Response("not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      return new Response(request.method === "HEAD" ? null : object.body, { headers });
    }
    return deployed.fetch(request, env, ctx);
  },
  scheduled: deployed.scheduled,
} satisfies ExportedHandler<Env>;
