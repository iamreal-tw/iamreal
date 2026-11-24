// One case of spec/vectors/records-response.json, computed by web/'s code:
// the body of a 201 of `POST /api/v1/records` read as src/api.ts reads it
// (submitRecord), then compared with the rows the confirmation screen
// showed (src/flow.ts, mismatchesOf). The generator (test/generate/) and
// the test (records-response.test.ts) both use it.
import { type Submission, submitRecord } from "../src/api.ts";
import { type ConsequenceRow, mismatchesOf } from "../src/flow.ts";

/** A row the confirmation screen showed: the fields the comparison reads. */
export type ShownRow = Pick<ConsequenceRow, "platform" | "kind" | "username">;

/** A case's input: the body as the server sent it (its text), and the rows the confirmation screen showed. */
export interface RecordsResponseCase {
  body: string;
  rows: ShownRow[];
}

/** The result of a case, in the vectors' spelling. */
export interface RecordsResponseResult {
  seq: number | null;
  record_hash: string | null;
  ordinal: number | null;
  kinds: { platform: string; kind: string; username: string; account_cards: number | null }[] | null;
  mismatches: string[];
}

/** Any submission: the answer is read without it. */
const SUBMISSION: Submission = { scope_string: "", scoped_id: "", accounts: [], challenge: "", issuer: "G3", smt_root: "", circuit: "", proof: "" };

export async function recordsResponseResult(c: RecordsResponseCase): Promise<RecordsResponseResult> {
  const accepted = await submitRecord(async () => new Response(c.body, { status: 201, headers: { "content-type": "application/json" } }), SUBMISSION);
  return {
    seq: accepted.seq,
    record_hash: accepted.recordHash,
    ordinal: accepted.ordinal,
    kinds: accepted.kinds === null ? null : accepted.kinds.map((k) => ({ platform: k.platform, kind: k.kind, username: k.username, account_cards: k.accountCards })),
    mismatches: mismatchesOf(c.rows, accepted.kinds),
  };
}
