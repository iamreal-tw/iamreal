// `node --experimental-strip-types scripts/build-deploy.ts <outdir>`: makes
// the deploy build in <outdir> and checks it (`buildDeploy`, deploy.ts). It
// reads no token and uploads nothing. The workflow's build job runs it
// (.github/workflows/deploy-test.yml); `pnpm run deploy:test` does the same
// through deploy-test.ts.
import { buildDeploy } from "./deploy.ts";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0]!.startsWith("-")) throw new Error("usage: build-deploy.ts <outdir>");
process.stdout.write(buildDeploy(args[0]!));
console.log(`The deploy build is in ${args[0]}, checked.`);
