// `pnpm dev`: the Worker on this computer, in the local workerd, with no
// Cloudflare account. It is the test build next to a fake MOICA
// (test/harness.ts), so nothing here sends a request to MOICA. The simulated
// R2 bucket starts empty each time.
//
// Enter runs the hourly schedule once and lists the bucket; Ctrl-C stops.
import { createInterface } from "node:readline";
import { startWorker } from "../test/harness.ts";

const worker = await startWorker();
worker.moica.serve("G2", new TextEncoder().encode("the fake MOICA's G2 CRL (not a CRL)"));
worker.moica.serve("G3", new TextEncoder().encode("the fake MOICA's G3 CRL (not a CRL)"));
console.log(`The Worker (test build): ${worker.url.href}`);
console.log(`The fake MOICA: ${worker.moica.origin}`);
console.log("Enter: run the hourly schedule once. Ctrl-C: stop.");

let shown = 0;
const lines = createInterface({ input: process.stdin });
lines.on("line", async () => {
  const { outcome } = await worker.runSchedule();
  const log = worker.logLines();
  for (const line of log.slice(shown)) console.log(line);
  shown = log.length;
  console.log(`schedule: ${outcome}`);
  for (const f of await worker.files()) console.log(`  ${f.key}  ${f.bytes.length} bytes  ${f.cacheControl ?? "(no Cache-Control)"}`);
});

const stop = async (): Promise<void> => {
  lines.close();
  await worker.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
