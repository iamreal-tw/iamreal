// `node --experimental-strip-types scripts/build-deploy.ts <outdir>`: builds
// the card proof page into site/proof/ and checks it (`buildSite`,
// deploy.ts), then makes the deploy build of the Worker in <outdir> and
// checks it (`buildDeploy`). It reads no token and uploads nothing. The
// workflow's build job runs it (.github/workflows/deploy-test.yml) and hands
// both on to the job that uploads; `pnpm run deploy:test` does the same
// through deploy-test.ts. The page's build needs web/crs/ (`pnpm fetch-crs`
// in web/): without it the page's check fails.
import { buildDeploy, buildSite } from "./deploy.ts";
import { PROOF_DIR } from "./proof-page.ts";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0]!.startsWith("-")) throw new Error("usage: build-deploy.ts <outdir>");
buildSite();
console.log(`The card proof page is in ${PROOF_DIR}, checked.`);
process.stdout.write(buildDeploy(args[0]!));
console.log(`The deploy build is in ${args[0]}, checked.`);
