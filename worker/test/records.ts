// What the tests of `POST /api/v1/records` share: the request as a device
// sends it, the answers, and the CRLs most of them use. Everything goes
// through the Worker's HTTP (test/harness.ts).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EMPTY_FINGERPRINT, LINES_PER_FILE, type ProofLogRecord, hashList, hashListName, nextFingerprint, readRecordLine, recordHash, proofLogFileName } from "iamreal-protocol/record.ts";
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

/** The answer of `card-state` for a card of the test log. */
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
 * one whose first byte is 1, cannot run on one whose first byte is 2, and
 * accepts one whose first byte is 3 with the Worker's clock a millisecond
 * later than it was.
 */
export function proofText(first: 0 | 1 | 2 | 3, second = 0): string {
  const bytes = Buffer.alloc(14656);
  bytes[0] = first;
  bytes[1] = second;
  return bytes.toString("base64");
}

export const GOOD_PROOF = proofText(0);
export const BAD_PROOF = proofText(1);
export const UNVERIFIABLE_PROOF = proofText(2);
/** A proof that verifies, the verdict coming one millisecond of the Worker's clock after the verifier was asked. */
export const SLOW_PROOF = proofText(3);

/** The CRLs most tests use are dated 2026-11-20 in Taiwan: `thisUpdate` 2026-11-19 21:00 UTC is 05:00 there. */
export const CRL_TIME = new Date("2026-11-19T21:00:00Z");
/** When most tests begin: noon of that date in Taiwan. */
export const START = new Date("2026-11-20T12:00:00+08:00");
export const DAY_MS = 24 * 3600 * 1000;

let proofLogs = 0;

/**
 * From now on the Worker serves a proof log without a record and an archive
 * without a CRL, at noon of 2026-11-20 in Taiwan: a proof log's object with a
 * new name, and an empty bucket. Returns the object's name. The object of
 * the proof log before is replaced as a deploy replaces it
 * (`switchProofLog`), before the bucket is emptied: nothing of it is
 * written there afterwards.
 */
export async function freshProofLog(worker: TestWorker, settings: { kind?: "test" | "production"; restrictLateSwitches?: boolean; clearedOn?: string } = {}): Promise<string> {
  proofLogs++;
  const name = settings.kind === "production" ? `proof-log-${proofLogs}` : `test-records-${proofLogs}`;
  await worker.switchProofLog({ PROOF_LOG_KIND: settings.kind ?? "test", PROOF_LOG_OBJECT_NAME: name, ...(settings.restrictLateSwitches && { RESTRICT_LATE_SWITCHES: "true" }), ...(settings.clearedOn !== undefined && { TEST_PROOF_LOG_CLEARED_ON: settings.clearedOn }) });
  for (const file of await worker.files()) await worker.deleteFile(file.key);
  await worker.setClock(START);
  return name;
}

/**
 * For a test about to compare the lines one request writes with every line
 * written meanwhile (`logLines().slice(…)`): the proof log's object has no
 * alarm about to ring, which would write its own lines in between. Its
 * alarm is not set, or set further ahead than such a test takes. Fails at
 * once when it is not so, rather than now and then on the comparison.
 */
export async function alarmNotSoon(worker: TestWorker): Promise<void> {
  const ms = await worker.proofLog.alarmInMs();
  assert.ok(ms === null || ms > 30 * 1000, `the proof log's alarm rings in ${ms} ms, while the test compares the lines`);
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

/** The `Cache-Control` of a full log file and of its record hash list in the data bucket (ADR-0027). */
export const IMMUTABLE = "public, max-age=31536000, immutable";
/** The `Content-Type` of a log file in the data bucket, and of a record hash list. */
export const PROOF_LOG_FILE_TYPE = "application/x-ndjson";
export const HASH_LIST_TYPE = "text/plain; charset=utf-8";

/**
 * Checks the whole proof log, the full log files in the data bucket and
 * then what the proof log's object stores of its records, against
 * spec/record.md, computing everything again from the lines alone, and
 * returns the records:
 *
 *   - the object's stored records begin right after a number of full files
 *     (none, for a proof log that has not filled one), and each of those files
 *     is in the bucket with 1,000 lines, next to its record hash list;
 *   - every line, of a file or stored, is a well-formed line of a log
 *     file of `kind` ("Check a line"), and the `seq`s are 1, 2, 3 and so
 *     on, in the line and in the stored row;
 *   - every record hash, in a list or stored, is the hash of its line's
 *     record, and the first line of a list is the proof log fingerprint at the
 *     end of the file before;
 *   - every stored `fingerprint` is the proof log fingerprint up to its
 *     record, each computed from the one before, the first from 64 zeros;
 *   - the row of the proof log has the number of records and the last
 *     fingerprint, and `card-state` reports the same number.
 *
 * It is the Go backend's check of the proof log (e159ab9:server/harness_test.go), which asks
 * the Go store for the same.
 */
export async function checkProofLog(worker: TestWorker, kind: "test" | "production" = "test"): Promise<ProofLogRecord[]> {
  const { records: rows, proofLog } = await worker.proofLog.stored();
  const records: ProofLogRecord[] = [];
  let fingerprint = EMPTY_FINGERPRINT;
  const read = async (line: string): Promise<string> => {
    const record = readRecordLine(kind, line);
    if (record === null) throw new assert.AssertionError({ message: `the line of record ${records.length + 1} is not a well-formed line: ${line.slice(0, 200)}` });
    records.push(record);
    assert.equal(record.seq, records.length, "the `seq` of a line");
    return recordHash(record);
  };

  // The full files the object no longer keeps the records of.
  const moved = (rows[0]?.seq ?? proofLog.count + 1) - 1;
  assert.equal(moved % LINES_PER_FILE, 0, "the stored records begin at a log file");
  const bucket = new Map((await worker.files("proof-log/")).map((f) => [f.key, f]));
  for (let before = 0; before < moved; before += LINES_PER_FILE) {
    const file = bucket.get(`proof-log/${proofLogFileName(before)}`);
    const list = bucket.get(`proof-log/${hashListName(before)}`);
    assert.ok(file && list, `the log file after ${before} records and its record hash list are in the bucket`);
    assert.deepEqual([file.cacheControl, list.cacheControl], [IMMUTABLE, IMMUTABLE]);
    assert.deepEqual([file.contentType, list.contentType], [PROOF_LOG_FILE_TYPE, HASH_LIST_TYPE]);
    const lines = new TextDecoder().decode(file.bytes).split("\n");
    assert.equal(lines.pop(), "", "a log file ends with LF");
    assert.equal(lines.length, LINES_PER_FILE, "the lines of a full file");
    const hashes: string[] = [];
    const fingerprintBefore = fingerprint;
    for (const line of lines) {
      hashes.push(await read(`${line}\n`));
      fingerprint = await nextFingerprint(fingerprint, hashes.at(-1)!);
    }
    assert.equal(new TextDecoder().decode(list.bytes), hashList(fingerprintBefore, hashes), `the record hash list of the file after ${before} records`);
  }

  for (const row of rows) {
    const hash = await read(row.line);
    assert.equal(row.seq, records.length, "the stored `seq`s");
    assert.equal(row.record_hash, hash, `the stored record hash of record ${row.seq}`);
    fingerprint = await nextFingerprint(fingerprint, hash);
    assert.equal(row.fingerprint, fingerprint, `the stored proof log fingerprint at record ${row.seq}`);
  }
  assert.deepEqual(proofLog, { count: records.length, fingerprint }, "the row of the proof log");
  const scope = kind === "production" ? "iamreal:public:0_______________" : TEST_SCOPE;
  assert.equal((await cardState(worker, newCard(), scope)).count, records.length, "the count `card-state` reports");
  return records;
}
