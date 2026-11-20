// What the tests of `POST /api/v1/records` share: the request as a device
// sends it, the answers, and the CRLs most of them use. Everything goes
// through the Worker's HTTP (test/harness.ts).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EMPTY_FINGERPRINT, type RosterRecord, nextFingerprint, readRecordLine, recordHash } from "iamreal-protocol/record.ts";
import { scopedIdText } from "iamreal-protocol/scoped-id.ts";
import { CIRCUITS } from "../src/circuits.ts";
import type { IssuerName } from "../src/issuers.ts";
import { makeCrl } from "./crls.ts";
import type { TestWorker } from "./harness.ts";

export const TEST_SCOPE = "iamreal-test:public:0__________";

export interface SubmittedAccount {
  readonly platform: string;
  readonly username: string;
}

/** The body of `POST /api/v1/records` (docs/api/card-proof.md). */
export interface Submission {
  readonly scope_string: string;
  readonly scoped_id: string;
  readonly accounts: readonly SubmittedAccount[];
  readonly challenge: string;
  readonly issuer: string;
  readonly smt_root: string;
  readonly circuit: string;
  readonly proof: string;
}

export interface Answer {
  readonly status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
}

/** Sends a body to `POST /api/v1/records` as it is. */
export async function submitText(worker: TestWorker, body: string): Promise<Answer> {
  const res = await worker.fetch("/api/v1/records", { method: "POST", body });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

export const submit = (worker: TestWorker, s: Submission): Promise<Answer> => submitText(worker, JSON.stringify(s));

/** The answer of `card-state` for a card of the test roster. */
export async function cardState(worker: TestWorker, scopedId: string, scope = TEST_SCOPE): Promise<Record<string, unknown>> {
  const res = await worker.fetch("/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: scope, scoped_id: scopedId }) });
  assert.equal(res.status, 200);
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

/** The kinds of a `201` as "platform kind" pairs separated by ", ". */
export function kindsOf(body: { kinds?: { platform: string; kind: string }[] }): string {
  return (body.kinds ?? []).map((k) => `${k.platform} ${k.kind}`).join(", ");
}

/** An account list from "platform:username" strings, in the order given: the tests also send lists in other orders. */
export function list(...accounts: string[]): SubmittedAccount[] {
  return accounts.map((a) => {
    const at = a.indexOf(":");
    return { platform: a.slice(0, at), username: a.slice(at + 1) };
  });
}

/** A new random scoped ID, in its one spelling. */
export function newCard(): string {
  return scopedIdText(BigInt(`0x${randomBytes(31).toString("hex")}`)); // below 2^248, so below p
}

/** The `circuit` field of a record of an issuer key: the SHA-256 of its circuit's verification key. */
export const circuitOf = (issuer: IssuerName): string => (issuer === "G2" ? CIRCUITS.card_proof_rs2048 : CIRCUITS.card_proof_rs4096).verificationKeySha256;

/**
 * Placeholder proof bytes in a record's spelling, for the stand-in verifier
 * (test-build/index.ts): it accepts a proof whose first byte is 0, rejects
 * one whose first byte is 1, and cannot run on one whose first byte is 2.
 */
export function proofText(first: 0 | 1 | 2, second = 0): string {
  const bytes = Buffer.alloc(14656);
  bytes[0] = first;
  bytes[1] = second;
  return bytes.toString("base64");
}

export const GOOD_PROOF = proofText(0);
export const BAD_PROOF = proofText(1);
export const UNVERIFIABLE_PROOF = proofText(2);

/** The CRLs most tests use are dated 2026-11-20 in Taiwan: `thisUpdate` 2026-11-19 21:00 UTC is 05:00 there. */
export const CRL_TIME = new Date("2026-11-19T21:00:00Z");
/** When most tests begin: noon of that date in Taiwan. */
export const START = new Date("2026-11-20T12:00:00+08:00");
export const DAY_MS = 24 * 3600 * 1000;

let rosters = 0;

/**
 * From now on the Worker serves a roster without a record and an archive
 * without a CRL, at noon of 2026-11-20 in Taiwan: a roster's object with a
 * new name, and an empty bucket. Returns the object's name.
 */
export async function freshRoster(worker: TestWorker, settings: { kind?: "test" | "production"; restrictLateSwitches?: boolean } = {}): Promise<string> {
  for (const file of await worker.files()) await worker.deleteFile(file.key);
  rosters++;
  const name = settings.kind === "production" ? `roster-${rosters}` : `test-records-${rosters}`;
  await worker.setSettings({ ROSTER_KIND: settings.kind ?? "test", ROSTER_OBJECT_NAME: name, ...(settings.restrictLateSwitches && { RESTRICT_LATE_SWITCHES: "true" }) });
  await worker.setClock(START);
  return name;
}

/** A moment given in Taiwan time. */
export const tw = (date: string, time: string): Date => new Date(`${date}T${time}+08:00`);

/**
 * From now on the fake MOICA has this CRL for its issuer key, and the mirror
 * has fetched it. Returns the root of its tree, as the archive index in the
 * data bucket lists it.
 */
export async function publishCrl(worker: TestWorker, c: { issuer: IssuerName; number: number; thisUpdate: Date; serials?: readonly number[] }): Promise<string> {
  worker.moica.serve(c.issuer, makeCrl({ issuer: c.issuer, number: BigInt(c.number), thisUpdate: c.thisUpdate, serials: (c.serials ?? []).map(BigInt) }));
  // The round ends as failed when the other issuer key has no CRL at the fake MOICA; it has done everything else by then.
  await worker.runSchedule();
  const index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]!.bytes);
  for (const line of index.split("\n").slice(0, -1)) {
    const l = JSON.parse(line) as { issuer: string; crl_number: string; root: string };
    if (l.issuer === c.issuer && l.crl_number === String(c.number)) return l.root;
  }
  throw new Error(`the index has no line for ${c.issuer} ${c.number}`);
}

/** The G3 CRL most tests start with: number 1, dated 2026-11-20, serials 11 and 12. Returns its root. */
export const publishG3 = (worker: TestWorker): Promise<string> => publishCrl(worker, { issuer: "G3", number: 1, thisUpdate: CRL_TIME, serials: [11, 12] });

/**
 * Moves to `n` days after START: MOICA publishes the G3 CRL of that day
 * (number 1 + n, the same serials, so the same root), the mirror fetches it,
 * and the clock shows noon of that day.
 */
export async function day(worker: TestWorker, n: number): Promise<void> {
  await publishCrl(worker, { issuer: "G3", number: 1 + n, thisUpdate: new Date(CRL_TIME.getTime() + n * DAY_MS), serials: [11, 12] });
  await worker.setClock(new Date(START.getTime() + n * DAY_MS));
}

/** A submission of a G3 card proof of `card` with a new challenge; accounts are "platform:username", in the order given. */
export async function sub(worker: TestWorker, card: string, root: string, ...accounts: string[]): Promise<Submission> {
  return { scope_string: TEST_SCOPE, scoped_id: card, accounts: list(...accounts), challenge: await worker.issueChallenge(), issuer: "G3", smt_root: root, circuit: circuitOf("G3"), proof: GOOD_PROOF };
}

/** Submits and expects `201` with these kinds, written as `kindsOf` writes them. */
export async function mustSubmit(worker: TestWorker, s: Submission, kinds: string): Promise<Answer["body"]> {
  const answer = await submit(worker, s);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(kindsOf(answer.body), kinds);
  return answer.body;
}

/** Submits and expects this error. */
export async function wantError(worker: TestWorker, s: Submission, status: number, code: string, what?: string): Promise<void> {
  assert.deepEqual(await submit(worker, s), { status, body: { error: code } }, what);
}

/**
 * Checks what the roster's object stores of its records against
 * spec/record.md, computing everything again from the stored lines alone,
 * and returns the records:
 *
 *   - every `line` is a well-formed line of a roster file of `kind` ("Check
 *     a line"), and the `seq`s are 1, 2, 3 and so on, in the row and in the
 *     line;
 *   - every `record_hash` is the hash of its line's record;
 *   - every `fingerprint` is the roster fingerprint up to its record, each
 *     computed from the one before, the first from 64 zeros;
 *   - the row of the roster has the number of records and the last
 *     fingerprint, and `card-state` reports the same number.
 *
 * It is the Go backend's `checkRoster` (server/harness_test.go), which asks
 * the Go store for the same.
 */
export async function checkRoster(worker: TestWorker, kind: "test" | "production" = "test"): Promise<RosterRecord[]> {
  const { records: rows, roster } = await worker.roster.stored();
  const records: RosterRecord[] = [];
  let fingerprint = EMPTY_FINGERPRINT;
  for (const [i, row] of rows.entries()) {
    const record = readRecordLine(kind, row.line);
    if (record === null) throw new assert.AssertionError({ message: `the stored line of record ${i + 1} is not a well-formed line: ${row.line.slice(0, 200)}` });
    assert.deepEqual([row.seq, record.seq], [i + 1, i + 1], "the stored `seq`s");
    const hash = await recordHash(record);
    assert.equal(row.record_hash, hash, `the stored record hash of record ${i + 1}`);
    fingerprint = await nextFingerprint(fingerprint, hash);
    assert.equal(row.fingerprint, fingerprint, `the stored roster fingerprint at record ${i + 1}`);
    records.push(record);
  }
  assert.deepEqual(roster, { count: records.length, fingerprint }, "the row of the roster");
  const scope = kind === "production" ? "iamreal:public:0_______________" : TEST_SCOPE;
  assert.equal((await cardState(worker, newCard(), scope)).count, records.length, "the count `card-state` reports");
  return records;
}
