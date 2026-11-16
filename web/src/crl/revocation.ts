// The device's side of spec/revocation-tree.md ("Who checks what", "The
// device") and ADR-0015: find the newest CRL of its own issuer in the
// mirror's index, download it, and check everything itself. The index is
// used only to find the file.
import { type Fetch, ServerError, getBytes } from "../api.ts";
import { sha256Hex } from "../bytes.ts";
import { type IssuerKey, importRsaKey } from "../issuers.ts";
import { type Day, taiwanDayOfSeconds } from "../spec/date.ts";
import type { CrlNumberStore } from "../storage.ts";
import { Unusable, type UsableCrl, usableCrl } from "./crl.ts";

/** The bound built into the device: the widest the record rule is expected to become (ADR-0015). */
export const BUILT_IN_MAX_AGE_DAYS = 7;

/** L: the smaller of the server's figure and the built-in 7. The server can only make it stricter. */
export function crlMaxAge(serverDays: number): number {
  return Math.min(serverDays, BUILT_IN_MAX_AGE_DAYS);
}

export type RevocationProblem =
  /** No usable line for the issuer in the index, or the index or the file could not be fetched. */
  | { code: "crl_unavailable"; detail: string }
  /** The file's SHA-256 is not the one its name (and the index) says. */
  | { code: "crl_hash" }
  /** The file is not a usable CRL under the issuer key (spec "Which CRLs"); `reason` is the archive reason code. */
  | { code: "crl_unusable"; reason: string }
  /** The CRL number is lower than the highest this device has used for the issuer. */
  | { code: "crl_rollback"; crlNumber: bigint; highest: bigint }
  /** Today is more than L days after the CRL date. */
  | { code: "crl_stale"; days: number; maxDays: number };

export class RevocationError extends Error {
  readonly problem: RevocationProblem;
  constructor(problem: RevocationProblem) {
    super(problem.code);
    this.problem = problem;
  }
}

export interface IndexChoice {
  crlNumber: bigint;
  sha256: string;
}

/**
 * The usable line of `issuer` with the highest `crl_number`. Lines this
 * reader cannot read are skipped: nothing in them is trusted anyway.
 * Two different files with the same highest number: no choice is made.
 */
export function chooseFromIndex(indexText: string, issuer: string): IndexChoice | RevocationProblem {
  let best: IndexChoice | null = null;
  let tie = false;
  for (const line of indexText.split("\n")) {
    if (line === "") continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o !== "object" || o === null) continue;
    const r = o as Record<string, unknown>;
    if (r.issuer !== issuer) continue;
    if (typeof r.root !== "string" || !/^[0-9a-f]{64}$/.test(r.root)) continue; // not usable per the index
    if (typeof r.crl_number !== "string" || !/^(0|[1-9][0-9]*)$/.test(r.crl_number)) continue;
    if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) continue;
    const n = BigInt(r.crl_number);
    if (best === null || n > best.crlNumber) {
      best = { crlNumber: n, sha256: r.sha256 };
      tie = false;
    } else if (n === best.crlNumber && r.sha256 !== best.sha256) tie = true;
  }
  if (best === null) return { code: "crl_unavailable", detail: `no usable line for ${issuer} in the index` };
  if (tie) return { code: "crl_unavailable", detail: "two different files share the highest CRL number" };
  return best;
}

export interface CheckedCrl extends UsableCrl {
  crlDay: Day;
  sha256: string;
}

/**
 * Downloads and checks the CRL the device will build its tree from. Throws
 * RevocationError. On success the CRL number is remembered for the issuer.
 */
export async function loadCrl(opts: { fetch: Fetch; issuer: IssuerKey; today: Day; maxAgeDays: number; store: CrlNumberStore }): Promise<CheckedCrl> {
  const { fetch: fetchFn, issuer, today, maxAgeDays, store } = opts;
  let indexText: string;
  try {
    indexText = new TextDecoder("utf-8", { fatal: true }).decode(await getBytes(fetchFn, "/crl/index.jsonl"));
  } catch (e) {
    throw new RevocationError({ code: "crl_unavailable", detail: `index: ${e instanceof ServerError ? e.code : "unreadable"}` });
  }
  const choice = chooseFromIndex(indexText, issuer.name);
  if ("code" in choice) throw new RevocationError(choice);

  let der: Uint8Array;
  try {
    der = await getBytes(fetchFn, `/crl/${choice.sha256}.crl`);
  } catch (e) {
    throw new RevocationError({ code: "crl_unavailable", detail: `file: ${e instanceof ServerError ? e.code : "unreadable"}` });
  }
  const sha256 = await sha256Hex(der);
  if (sha256 !== choice.sha256) throw new RevocationError({ code: "crl_hash" });

  let crl: UsableCrl;
  try {
    crl = await usableCrl(der, await importRsaKey(issuer.modulus, issuer.bits), issuer.bits);
  } catch (e) {
    if (e instanceof Unusable) throw new RevocationError({ code: "crl_unusable", reason: e.code });
    throw e;
  }

  const highest = store.get(issuer.name);
  if (highest !== null && crl.crlNumber < highest) {
    throw new RevocationError({ code: "crl_rollback", crlNumber: crl.crlNumber, highest });
  }
  const crlDay = taiwanDayOfSeconds(crl.thisUpdate);
  if (today - crlDay > maxAgeDays) throw new RevocationError({ code: "crl_stale", days: today - crlDay, maxDays: maxAgeDays });

  if (highest === null || crl.crlNumber > highest) store.set(issuer.name, crl.crlNumber);
  return { ...crl, crlDay, sha256 };
}
