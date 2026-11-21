// MOICA's issuer keys as the specification has them (spec/vectors/issuers.json):
// what the checks of a deploy compare the Worker's build and the card proof
// page's build with (deploy-build-checks.ts, proof-page.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** MOICA's two moduli as spec/vectors/issuers.json gives them: lowercase hex, no prefix. */
export function moduliInSpec(): string[] {
  const vectors = JSON.parse(readFileSync(join(REPO, "spec", "vectors", "issuers.json"), "utf8")) as { issuers: { modulus: string }[] };
  assert.equal(vectors.issuers.length, 2);
  return vectors.issuers.map((i) => i.modulus.replace(/^0x/, "").toLowerCase());
}
