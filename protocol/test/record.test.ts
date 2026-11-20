// The record's line, its hash and the roster fingerprint (spec/record.md)
// against spec/vectors/record.json, the file the Go tests read.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EMPTY_FINGERPRINT, FINGERPRINT_VERSION, accountsText, nextFingerprint, readRecordLine, recordHash, recordLine } from "../src/record.ts";
import { vectors } from "./vectors.ts";

const v = vectors("record.json");

/** A text of the vectors with its tokens (`@PROOF1@`, …) replaced by the strings they stand for. */
function filled(text: string): string {
  for (const [token, value] of Object.entries(v.tokens as Record<string, string>)) text = text.split(token).join(value);
  return text;
}

/** A record of the vectors, its keys as the specification spells them, as this implementation takes it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recordOf = (r: any) => ({ seq: r.seq, scopeString: r.scope_string, scopedId: r.scoped_id, accounts: r.accounts, challenge: r.challenge, issuer: r.issuer, smtRoot: r.smt_root, circuit: r.circuit, proof: filled(r.proof) });

describe("record.json", () => {
  test("the version of the fingerprint and the fingerprint of the empty roster", () => {
    assert.equal(FINGERPRINT_VERSION, v.fingerprint_version);
    assert.equal(EMPTY_FINGERPRINT, v.empty_fingerprint);
  });

  for (const roster of v.rosters) {
    test(`the ${roster.roster} roster: each record's list, line, hash, and the fingerprint once it is added`, async () => {
      let fingerprint = EMPTY_FINGERPRINT;
      for (const r of roster.records) {
        const record = recordOf(r.record);
        assert.equal(accountsText(record.accounts), r.accounts_text);
        assert.equal(recordLine(record), filled(r.line));
        assert.equal(await recordHash(record), r.record_hash);
        fingerprint = await nextFingerprint(fingerprint, r.record_hash);
        assert.equal(fingerprint, r.fingerprint);
        assert.deepEqual(readRecordLine(roster.roster, filled(r.line)), record);
      }
      assert.equal(fingerprint, roster.fingerprint);
    });
  }

  test("every well-formed line is read, and written again it is the same bytes", () => {
    assert.ok(v.well_formed_lines.length > 0);
    for (const c of v.well_formed_lines) {
      const line = filled(c.line);
      const record = readRecordLine(c.roster, line);
      assert.notEqual(record, null, line.slice(0, 200));
      assert.equal(recordLine(record!), line);
    }
  });

  for (const c of v.malformed_lines) {
    test(`malformed (${c.reason}), ${c.roster} roster`, () => assert.equal(readRecordLine(c.roster, filled(c.line)), null));
  }
});
