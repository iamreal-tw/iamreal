// Runs the whole card proof on this computer, with a real card, reader and
// MOICA's component: builds the page (production: MOICA's issuer keys, the
// component at http://localhost:61161), fetches the CRS if it is missing,
// builds the server, runs the CRL mirror once against MOICA's real CRLs, and
// serves the page and the API with the production roster on
// http://localhost:PORT/: the production build signs the public roster's
// scope string (src/target.ts), which only the production roster accepts,
// and its platform table has Threads alone. Stop it with Ctrl-C.
//
//   IAMREAL_BB=/path/to/bb pnpm local [--port 8080] [--data DIR]
//
// The data directory (default web/local/) keeps the roster between runs;
// delete it to start from an empty roster. The two requests to other hosts
// are the CRS download (scripts/fetch-crs.mjs, only if crs/ is missing) and
// the mirror's download of MOICA's two CRLs.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..");
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const port = Number(opt("--port", "8080"));
const data = resolve(opt("--data", join(web, "local")));
const BB = process.env.IAMREAL_BB;
if (!BB) throw new Error("set IAMREAL_BB to the bb 6.0.0 executable (verifier/README.md)");

console.log("1/5 the CRS (scripts/fetch-crs.mjs)");
execFileSync(process.execPath, [join(web, "scripts", "fetch-crs.mjs")], { stdio: "inherit" });

console.log("2/5 the page (vite build --mode production)");
const dist = join(web, "dist");
await build({ root: web, configFile: join(web, "vite.config.ts"), mode: "production", logLevel: "warn", build: { outDir: dist, emptyOutDir: true } });

console.log("3/5 the server (go build ./server)");
mkdirSync(data, { recursive: true });
const server = join(data, "iamreal-server");
execFileSync("go", ["build", "-o", server, "./server"], { cwd: repo, stdio: "inherit" });
// bb verify reads only the first G1 point, (1, 2) (verifier/README.md).
const crs = join(data, "crs");
mkdirSync(crs, { recursive: true });
const point = new Uint8Array(64);
point[31] = 1;
point[63] = 2;
writeFileSync(join(crs, "bn254_g1.dat"), point);

console.log("4/5 the CRL mirror, once (MOICA's G2 and G3 CRLs)");
execFileSync(server, ["mirror", "-data", data], { stdio: "inherit" });

console.log(`5/5 serving http://localhost:${port}/ (production roster; Ctrl-C to stop)`);
const child = spawn(
  server,
  ["serve", "-data", data, "-bb", BB, "-crs", crs, "-addr", `127.0.0.1:${port}`, "-web", dist, "-roster", "production", "-mirror=false"],
  { stdio: "inherit" },
);
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 0));
