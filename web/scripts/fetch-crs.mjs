// Downloads the part of Barretenberg's common reference string the page
// needs into crs/ (excluded from version control) and checks each file
// against the SHA-256 written here and in src/prover/crs.ts. The page then
// serves these files from its own origin (README.md); it never asks Aztec's
// CDN at run time.
//
//   node scripts/fetch-crs.mjs
//
// The only request this repository's web/ ever makes to another domain. It
// carries no project or personal information.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "crs");

const POINTS = 2 ** 18;
// Keep in step with src/prover/crs.ts.
const FILES = [
  {
    name: "bn254_g1_compressed_2p18.dat",
    url: "https://crs.aztec-cdn.foundation/g1_compressed.dat",
    range: `bytes=0-${POINTS * 32 - 1}`,
    size: POINTS * 32,
    sha256: "5107a7926d504236331b4872b7218a1ca18921b5358d894822576e1aeb684934",
  },
  {
    name: "bn254_g2.dat",
    url: "https://crs.aztec-cdn.foundation/g2.dat",
    size: 128,
    sha256: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f",
  },
];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

mkdirSync(out, { recursive: true });
for (const f of FILES) {
  const path = join(out, f.name);
  if (existsSync(path) && sha256(readFileSync(path)) === f.sha256) {
    console.log(`${f.name}: present, SHA-256 matches`);
    continue;
  }
  const res = await fetch(f.url, { headers: { ...(f.range && { Range: f.range }), "User-Agent": "crs-fetch" } });
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== f.size) throw new Error(`${f.name}: ${bytes.length} bytes, expected ${f.size}`);
  const got = sha256(bytes);
  if (got !== f.sha256) throw new Error(`${f.name}: SHA-256 ${got}, expected ${f.sha256}`);
  writeFileSync(path, bytes);
  console.log(`${f.name}: downloaded, SHA-256 matches`);
}
