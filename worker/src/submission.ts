// Reading the body of `POST /api/v1/records` (docs/api/card-proof.md,
// "Reading the request"): the fields of a record except `seq`, and which of
// `malformed`, `scope` and `platform` a body that is not one gets. Nothing
// here asks the proof log's object, and a submission that ends here does not
// count towards the challenge's five. Beside the record's fields a body may
// carry `device_id` (ADR-0039), which is no part of the record.
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { type RecordAccount, type RecordFields, fieldsProblem } from "iamreal-protocol/record.ts";
import { lookupScope } from "iamreal-protocol/scope.ts";
import { type Json, parseJson } from "./json.ts";
import type { ProofLogKind } from "./settings.ts";

/** The keys of the body whose values are strings, as the document spells them, and the field each is. */
const STRINGS = [
  ["scope_string", "scopeString"],
  ["scoped_id", "scopedId"],
  ["challenge", "challenge"],
  ["issuer", "issuer"],
  ["smt_root", "smtRoot"],
  ["circuit", "circuit"],
  ["proof", "proof"],
] as const;

/**
 * The accounts of a submitted list, in the order they came, if the value is
 * a list whose every element is an object with exactly the keys `platform`
 * and `username`, each once, both strings; null otherwise. Only such a list
 * can be `platform`. Nothing is sorted or filled in.
 */
function readAccounts(value: Json | undefined): RecordAccount[] | null {
  if (!Array.isArray(value)) return null;
  const accounts: RecordAccount[] = [];
  for (const element of value) {
    if (!(element instanceof Map) || element.size !== 2) return null;
    const platform = element.get("platform");
    const username = element.get("username");
    if (typeof platform !== "string" || typeof username !== "string") return null;
    accounts.push({ platform, username });
  }
  return accounts;
}

/** A card proof device ID (docs/api/card-proof.md, `device_id`): 16 random bytes as 32 lowercase hex digits. */
const DEVICE_ID = /^[0-9a-f]{32}$/;

/** What a body of `POST /api/v1/records` holds: the fields of a record, and the card proof device ID if it carried one. */
export interface Submission {
  readonly fields: RecordFields;
  /** Not a field of the record: it goes to the connection log alone (ADR-0022, ADR-0039). */
  readonly deviceId: string | null;
}

/**
 * The submission a body is, for the proof log `kind`, or the code it is refused
 * with. In the document's order:
 *
 *   1. not one JSON object with exactly the eight keys, or those and
 *      `device_id`, each once, every value but `accounts` a string:
 *      `malformed`;
 *   2. a scope string that is not this proof log's: `scope`;
 *   3. a list of well-shaped accounts with a platform outside this proof log's
 *      table: `platform`;
 *   4. anything else not in its format: `malformed`.
 */
export function readSubmission(kind: ProofLogKind, text: string): Submission | "malformed" | "scope" | "platform" {
  const body = parseJson(text);
  if (!(body instanceof Map) || !body.has("accounts")) return "malformed";
  const deviceId = body.get("device_id") ?? null;
  if (body.size !== STRINGS.length + 1 + (body.has("device_id") ? 1 : 0)) return "malformed";
  // A device ID is random: one in any other form is not one, and the body is not a submission.
  if (body.has("device_id") && (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId))) return "malformed";
  const strings = {} as Record<(typeof STRINGS)[number][1], string>;
  for (const [key, field] of STRINGS) {
    const value = body.get(key);
    if (typeof value !== "string") return "malformed";
    strings[field] = value;
  }
  if (!lookupScope(kind, strings.scopeString)) return "scope";
  const accounts = readAccounts(body.get("accounts"));
  if (accounts === null) return "malformed";
  const table = platformsOf(kind);
  if (accounts.some((a) => !table.some((row) => row.platform === a.platform))) return "platform";
  const fields: RecordFields = { ...strings, accounts };
  return fieldsProblem(kind, fields) === null ? { fields, deviceId: deviceId as string | null } : "malformed";
}
