// The record (spec/record.md): its fields and their formats, its one line,
// its hash, and the roster fingerprint. A record has exactly one spelling:
// the line is written from a template, and a line is read by writing it
// again and comparing bytes.
import { byBytes, sha256Hex } from "./bytes.ts";
import { parseChallenge } from "./challenge.ts";
import { P } from "./field.ts";
import { platformsOf } from "./platforms.ts";
import { type Roster, lookupScope } from "./scope.ts";
import { parseScopedId } from "./scoped-id.ts";

/** The version tag of the record hash. */
export const RECORD_VERSION = "iamreal-record-v1";
/** The version tag of the roster fingerprint. */
export const FINGERPRINT_VERSION = "iamreal-fingerprint-v1";
/** The roster fingerprint of the roster without a record: 64 zeros. */
export const EMPTY_FINGERPRINT = "0".repeat(64);
/** The largest `seq`: 2^53 − 1. */
export const MAX_SEQ = Number.MAX_SAFE_INTEGER;
/** A proof is exactly this many bytes. */
export const PROOF_LENGTH = 14656;
/** A proof in a record: standard base64 with padding of PROOF_LENGTH bytes. */
export const PROOF_TEXT_LENGTH = 19544;

/** An account of a record's list. */
export interface RecordAccount {
  readonly platform: string;
  readonly username: string;
}

/** The fields of a record except `seq`, each value written exactly as in the line: what a card proof submits. */
export interface RecordFields {
  readonly scopeString: string;
  readonly scopedId: string;
  /** The whole list, in the order of the line. */
  readonly accounts: readonly RecordAccount[];
  readonly challenge: string;
  readonly issuer: string;
  readonly smtRoot: string;
  readonly circuit: string;
  readonly proof: string;
}

/** A record of a roster. */
export interface RosterRecord extends RecordFields {
  readonly seq: number;
}

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The bytes of a proof written as in a record, or null if `text` is not the
 * one base64 spelling of exactly PROOF_LENGTH bytes: another length, a
 * character outside the alphabet, no padding, or unused bits that are not
 * zero.
 */
export function decodeProof(text: string): Uint8Array | null {
  if (text.length !== PROOF_TEXT_LENGTH || !BASE64.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  if (binary.length !== PROOF_LENGTH || btoa(binary) !== text) return null;
  const out = new Uint8Array(PROOF_LENGTH);
  for (let i = 0; i < PROOF_LENGTH; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * What is wrong with an account list of `roster` (spec/record.md, "The
 * account list"), or null: every platform is an ID of the roster's table,
 * the platforms are in strictly ascending order by byte value, and every
 * username is in the format of its own platform. Account by account: its
 * platform, then its place after the account before, then its username.
 */
export function accountsProblem(roster: Roster, accounts: readonly RecordAccount[]): "platform" | "order" | "username" | null {
  const table = platformsOf(roster);
  let last: string | null = null;
  for (const a of accounts) {
    const row = table.find((p) => p.platform === a.platform);
    if (row === undefined) return "platform";
    if (last !== null && byBytes(last, a.platform) >= 0) return "order";
    if (!row.format.accepts(a.username)) return "username";
    last = a.platform;
  }
  return null;
}

/**
 * The first field of `fields` that is not in its format for `roster`
 * (spec/record.md, "Fields"), by its name in the line, or null if every one
 * is. `circuit` is only checked to be 64 lowercase hex digits: whether it is
 * an accepted circuit, and the one of `issuer`, is part of verifying the
 * record.
 */
export function fieldsProblem(roster: Roster, fields: RecordFields): string | null {
  if (!lookupScope(roster, fields.scopeString)) return "scope_string";
  if (parseScopedId(fields.scopedId) === null) return "scoped_id";
  if (accountsProblem(roster, fields.accounts) !== null) return "accounts";
  if (parseChallenge(fields.challenge) === null) return "challenge";
  if (fields.issuer !== "G2" && fields.issuer !== "G3") return "issuer";
  if (!LOWER_HEX_64.test(fields.smtRoot) || BigInt(`0x${fields.smtRoot}`) >= P) return "smt_root";
  if (!LOWER_HEX_64.test(fields.circuit)) return "circuit";
  if (decodeProof(fields.proof) === null) return "proof";
  return null;
}

/** The account list written from its template, as it is in the line and in the record hash. It does not check the values. */
export function accountsText(accounts: readonly RecordAccount[]): string {
  return `[${accounts.map((a) => `{"platform":"${a.platform}","username":"${a.username}"}`).join(",")}]`;
}

/** The record's line, written from the template and followed by LF. It does not check the values. */
export function recordLine(r: RosterRecord): string {
  return `{"seq":${r.seq},"scope_string":"${r.scopeString}","scoped_id":"${r.scopedId}","accounts":${accountsText(r.accounts)},"challenge":"${r.challenge}","issuer":"${r.issuer}","smt_root":"${r.smtRoot}","circuit":"${r.circuit}","proof":"${r.proof}"}\n`;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The record hash: SHA-256 of the version tag and the nine fields as written in the line, separated by LF; 64 lowercase hex digits. */
export function recordHash(r: RosterRecord): Promise<string> {
  return sha256Hex(utf8([RECORD_VERSION, String(r.seq), r.scopeString, r.scopedId, accountsText(r.accounts), r.challenge, r.issuer, r.smtRoot, r.circuit, r.proof].join("\n")));
}

/** `fingerprint(n)` from `fingerprint(n − 1)` and `record_hash(n)`, each 64 lowercase hex digits. */
export function nextFingerprint(fingerprint: string, recordHashOfNext: string): Promise<string> {
  if (!LOWER_HEX_64.test(fingerprint) || !LOWER_HEX_64.test(recordHashOfNext)) throw new Error("not 64 lowercase hex digits");
  return sha256Hex(utf8(`${FINGERPRINT_VERSION}\n${fingerprint}\n${recordHashOfNext}`));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The record a line of a roster file of `roster` is, or null if the line is
 * malformed (spec/record.md, "Check a line"): `line` is the line's bytes up
 * to and including its LF. The line is parsed, every value checked against
 * its format, and the line written again from the template; if the bytes
 * differ, it is malformed. That one comparison refuses whatever JSON allows
 * beyond the template.
 */
export function readRecordLine(roster: Roster, line: string): RosterRecord | null {
  if (!line.endsWith("\n") || line.indexOf("\n") !== line.length - 1) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const { seq, scope_string, scoped_id, accounts, challenge, issuer, smt_root, circuit, proof } = v;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
  for (const s of [scope_string, scoped_id, challenge, issuer, smt_root, circuit, proof]) if (typeof s !== "string") return null;
  if (!Array.isArray(accounts)) return null;
  const list: RecordAccount[] = [];
  for (const a of accounts as unknown[]) {
    if (!isObject(a) || typeof a.platform !== "string" || typeof a.username !== "string") return null;
    list.push({ platform: a.platform, username: a.username });
  }
  const record: RosterRecord = {
    seq,
    scopeString: scope_string as string,
    scopedId: scoped_id as string,
    accounts: list,
    challenge: challenge as string,
    issuer: issuer as string,
    smtRoot: smt_root as string,
    circuit: circuit as string,
    proof: proof as string,
  };
  if (fieldsProblem(roster, record) !== null) return null;
  return recordLine(record) === line ? record : null;
}
