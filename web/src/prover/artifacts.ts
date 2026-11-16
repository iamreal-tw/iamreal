// The files the prover loads from the page's own origin, each checked
// against a SHA-256 written here before it is used. A server that serves
// other bytes stops the card proof; it cannot choose the circuit or the CRS.
import { type Fetch, getBytes } from "../api.ts";
import { sha256Hex } from "../bytes.ts";
import type { CircuitName } from "../issuers.ts";

/** circuits/README.md: the compiled circuits of zkid-noir 497b610, stripped. */
export const CIRCUITS: Readonly<Record<CircuitName, { path: string; sha256: string; vkSha256: string; publicInputs: number }>> =
  Object.freeze({
    card_proof_rs2048: Object.freeze({
      path: "/circuits/card_proof_rs2048.json",
      sha256: "8bd668a500df0109111e91ecac6c14554d2d9875b13cf8b9edf7bc194bf73de5",
      vkSha256: "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8",
      publicInputs: 23,
    }),
    card_proof_rs4096: Object.freeze({
      path: "/circuits/card_proof_rs4096.json",
      sha256: "9ee2aa5001acf3b7f78c09d8a7d1d68e13948073b7fcadea6fc6ab0596a6705a",
      vkSha256: "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
      publicInputs: 40,
    }),
  });

/** The CRS points: 2^18, enough for both circuits (232,239 gates at most). Same values as scripts/fetch-crs.mjs. */
export const CRS_POINTS = 2 ** 18;
export const CRS = Object.freeze({
  g1: Object.freeze({ path: "/crs/bn254_g1_compressed_2p18.dat", sha256: "5107a7926d504236331b4872b7218a1ca18921b5358d894822576e1aeb684934" }),
  g2: Object.freeze({ path: "/crs/bn254_g2.dat", sha256: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f" }),
});

export class ArtifactError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.path = path;
  }
}

/** Fetches a file and checks its SHA-256. */
export async function fetchChecked(fetchFn: Fetch, path: string, sha256: string): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await getBytes(fetchFn, path);
  } catch {
    throw new ArtifactError(path, "could not be fetched");
  }
  if ((await sha256Hex(bytes)) !== sha256) throw new ArtifactError(path, "SHA-256 is not the expected one");
  return bytes;
}

export interface CompiledCircuit {
  bytecode: string;
  abi: unknown;
}

/** The compiled circuit, after its SHA-256 check. */
export async function loadCircuit(fetchFn: Fetch, name: CircuitName): Promise<CompiledCircuit> {
  const c = CIRCUITS[name];
  const bytes = await fetchChecked(fetchFn, c.path, c.sha256);
  return JSON.parse(new TextDecoder().decode(bytes)) as CompiledCircuit;
}
