// The made-up proof log of the measurement (measure/README.md): log files of
// records that the record rules take, each of a card of its own, written
// straight into the measurement's data bucket, so that the proof log's
// object rebuilds from them (src/rebuild.ts, from the bucket alone). Never in
// the deployed build (test/bundle.test.ts).
//
// A record here is in every field's format (spec/record.md, "Check a line")
// and its proof is random bytes of a proof's length: nothing verifies it.
// The rebuild does not verify proofs (README.md, "從證明紀錄重建"), and no
// record of this proof log is ever written to the test log or the
// production one (ADR-0028).
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { type Day, formatDay } from "iamreal-protocol/date.ts";
import { scopedIdText } from "iamreal-protocol/scoped-id.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { LINES_PER_FILE, type ProofLogRecord, fingerprintLine, nextFingerprint, proofLogFileName, readRecordLine, recordHash, recordLine } from "iamreal-protocol/record.ts";
import { CIRCUITS, PROOF_LENGTH } from "../src/circuits.ts";
import { FINGERPRINT_FILE, PROOF_LOG_DIRECTORY } from "../src/proof-log-files.ts";

/** The root every made-up record names, and the CRL the writes of the measurement are given (measure-build/index.ts). */
export const MEASURE_ROOT = "0".repeat(63) + "1";

const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  // getRandomValues fills at most 65,536 bytes at a time.
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65_536)));
  return out;
};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

/** A scoped ID of a card of its own: 31 random bytes, below the field modulus. */
export const madeUpScopedId = (): string => scopedIdText(BigInt(`0x${[...randomBytes(31)].map((b) => b.toString(16).padStart(2, "0")).join("")}`));

/** A challenge of the day `day` (spec/challenge.md): its date and 16 random bytes. */
export const madeUpChallenge = (day: Day): string => `${formatDay(day)}.${encodeBase32(randomBytes(16))}`;

/** The fields of a made-up record of the test log, other than `seq` and its challenge: a card of its own, one Threads account, issuer G3. */
export function madeUpFields(challenge: string): Omit<ProofLogRecord, "seq"> {
  const scopedId = madeUpScopedId();
  return {
    scopeString: scopeOf("test"),
    scopedId,
    accounts: [{ platform: "threads", username: `m.${scopedId.slice(0, 20).toLowerCase()}` }],
    challenge,
    issuer: "G3",
    smtRoot: MEASURE_ROOT,
    circuit: CIRCUITS.card_proof_rs4096.verificationKeySha256,
    proof: base64(randomBytes(PROOF_LENGTH)),
  };
}

/**
 * The log file of the made-up proof log that begins after `before` records
 * (a multiple of 1,000), full, every record dated `day`, and the proof log
 * fingerprint after it. `fingerprintBefore` is the one after the file
 * before it (64 zeros before the first).
 */
export async function madeUpLogFile(before: number, fingerprintBefore: string, day: Day): Promise<{ key: string; text: string; fingerprintAfter: string }> {
  if (!Number.isSafeInteger(before) || before < 0 || before % LINES_PER_FILE !== 0) throw new Error("a log file begins after a multiple of 1,000 records");
  const lines: string[] = [];
  let fingerprint = fingerprintBefore;
  for (let n = 1; n <= LINES_PER_FILE; n++) {
    const record: ProofLogRecord = { ...madeUpFields(madeUpChallenge(day)), seq: before + n };
    const line = recordLine(record);
    if (readRecordLine("test", line) === null) throw new Error("a made-up record is not a well-formed line");
    lines.push(line);
    fingerprint = await nextFingerprint(fingerprint, await recordHash(record));
  }
  return { key: PROOF_LOG_DIRECTORY + proofLogFileName(before), text: lines.join(""), fingerprintAfter: fingerprint };
}

/** The fingerprint file of the made-up proof log: one line, of `day`, at `count` records. */
export const madeUpFingerprintFile = (day: Day, count: number, fingerprint: string): { key: string; text: string } => ({ key: FINGERPRINT_FILE, text: fingerprintLine({ date: day, count, fingerprint }) });
