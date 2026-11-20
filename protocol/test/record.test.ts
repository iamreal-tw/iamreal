// The record's line, its hash and the roster fingerprint (spec/record.md)
// against spec/vectors/record.json, the file the Go tests read.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256Hex } from "../src/bytes.ts";
import { parseDay } from "../src/date.ts";
import { EMPTY_FINGERPRINT, FINGERPRINT_VERSION, FINGERPRINT_FILE_NAME, LINES_PER_FILE, accountsText, fingerprintLine, hashList, hashListName, nextFingerprint, readRecordLine, recordHash, recordLine, rosterFileName } from "../src/record.ts";
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

describe("record.json, the roster directory of a generated roster", () => {
  const g = v.generated_roster;
  const lineOf = (seq: number): string => filled(g.line_template.split("@SEQ@").join(String(seq)));

  test("a full file has 1,000 lines", () => assert.equal(LINES_PER_FILE, 1000));

  for (const d of g.directories) {
    test(`${d.name}: the name and the bytes of each roster file and of each record hash list`, async () => {
      // The roster's lines, record hashes and fingerprints, from the line the vectors generate it from.
      const lines: string[] = [];
      const hashes: string[] = [];
      const fingerprints = [EMPTY_FINGERPRINT];
      for (let seq = 1; seq <= d.count; seq++) {
        const record = readRecordLine(d.roster, lineOf(seq));
        assert.notEqual(record, null);
        lines.push(recordLine(record!));
        hashes.push(await recordHash(record!));
        fingerprints.push(await nextFingerprint(fingerprints[seq - 1]!, hashes[seq - 1]!));
      }
      assert.equal(fingerprints[d.count], d.fingerprint);
      const files = [];
      const lists = [];
      for (let before = 0; before < d.count; before += LINES_PER_FILE) {
        const end = Math.min(before + LINES_PER_FILE, d.count);
        const file = lines.slice(before, end).join("");
        const list = hashList(fingerprints[before]!, hashes.slice(before, end));
        files.push({ name: rosterFileName(before), first_seq: before + 1, lines: end - before, sha256: await sha256Hex(new TextEncoder().encode(file)) });
        const listLines = list.split("\n");
        assert.equal(listLines.pop(), "", "a list ends with LF");
        lists.push({ name: hashListName(before), lines: listLines.length, first_line: listLines[0], last_line: listLines.at(-1), sha256: await sha256Hex(new TextEncoder().encode(list)) });
      }
      assert.deepEqual(files, d.files);
      assert.deepEqual(lists, d.hash_lists);
    });
  }

  test("the record hash list of each roster of three records", async () => {
    for (const roster of v.rosters) {
      assert.equal(hashList(EMPTY_FINGERPRINT, roster.records.map((r: { record_hash: string }) => r.record_hash)), roster.hash_list);
    }
  });
});

describe("record.json, the fingerprint file", () => {
  test("the line of each generated roster directory, published once on 2026-11-16 with every record", () => {
    for (const d of v.generated_roster.directories) {
      assert.equal(d.fingerprint_file.name, FINGERPRINT_FILE_NAME);
      assert.equal(fingerprintLine({ date: parseDay("2026-11-16")!, count: d.count, fingerprint: d.fingerprint }), d.fingerprint_file.content, d.name);
    }
  });

  test("every line of every valid fingerprint file, written again from its date, count and fingerprint", () => {
    const valid = v.fingerprint_files.filter((f: { valid: boolean }) => f.valid);
    assert.ok(valid.length >= 3);
    for (const f of valid) {
      const lines = (f.content as string).split("\n").slice(0, -1);
      assert.ok(lines.length > 0);
      const again = lines.map((line) => {
        const { date, count, fingerprint } = JSON.parse(line) as { date: string; count: number; fingerprint: string };
        return fingerprintLine({ date: parseDay(date)!, count, fingerprint });
      });
      assert.equal(again.join(""), f.content, f.name);
    }
  });

  test("a count or a fingerprint outside its format is not written", () => {
    const date = parseDay("2026-11-16")!;
    assert.throws(() => fingerprintLine({ date, count: -1, fingerprint: EMPTY_FINGERPRINT }));
    assert.throws(() => fingerprintLine({ date, count: 1.5, fingerprint: EMPTY_FINGERPRINT }));
    assert.throws(() => fingerprintLine({ date, count: 1, fingerprint: EMPTY_FINGERPRINT.toUpperCase().replace("0", "A") }));
  });
});
