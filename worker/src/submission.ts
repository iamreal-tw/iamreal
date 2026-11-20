// Reading the body of `POST /api/v1/records` (docs/api/card-proof.md,
// "Reading the request"): the fields of a record except `seq`, and which of
// `malformed`, `scope` and `platform` a body that is not one gets. Nothing
// here asks the roster's object, and a submission that ends here does not
// count towards the challenge's five.
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { type RecordAccount, type RecordFields, fieldsProblem } from "iamreal-protocol/record.ts";
import { lookupScope } from "iamreal-protocol/scope.ts";
import { type Json, parseJson } from "./json.ts";
import type { RosterKind } from "./settings.ts";

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

/**
 * The submission a body is, for the roster `kind`, or the code it is refused
 * with. In the document's order:
 *
 *   1. not one JSON object with exactly the eight keys, each once, every
 *      value but `accounts` a string: `malformed`;
 *   2. a scope string that is not this roster's: `scope`;
 *   3. a list of well-shaped accounts with a platform outside this roster's
 *      table: `platform`;
 *   4. anything else not in its format: `malformed`.
 */
export function readSubmission(kind: RosterKind, text: string): RecordFields | "malformed" | "scope" | "platform" {
  const body = parseJson(text);
  if (!(body instanceof Map) || body.size !== STRINGS.length + 1 || !body.has("accounts")) return "malformed";
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
  return fieldsProblem(kind, fields) === null ? fields : "malformed";
}
