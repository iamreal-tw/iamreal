// The counts (spec/counts.md): the table src/counts.ts has is the one of
// spec/vectors/counts.json and the one the document lists, and every case
// of the vectors is taken or dropped as the vectors say.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BROWSERS, CARD_PROOF_ACTIONS, CLIENTS, DURATIONS, EVENTS, OSES, PAGES, REASONS, SOURCES, STEPS, TAPS, TIMED_STEPS, VISITOR_ACTIONS, readCount, readCountText, tookOf } from "../src/counts.ts";
import { repoFile, vectors } from "./vectors.ts";

const file = vectors("counts.json");
const TABLE = { clients: CLIENTS, events: EVENTS, pages: PAGES, steps: STEPS, reasons: REASONS, card_proof_actions: CARD_PROOF_ACTIONS, visitor_actions: VISITOR_ACTIONS, taps: TAPS, timed_steps: TIMED_STEPS, durations: DURATIONS, sources: SOURCES, browsers: BROWSERS, oses: OSES };

describe("counts.json", () => {
  test("the table of the vectors is the one this implementation has, code for code and client for client", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(TABLE)), file.table);
  });

  for (const c of file.cases) {
    test(`${c.taken ? "taken" : "dropped"}: ${c.name}`, () => {
      const kept = readCount(c.count);
      assert.equal(kept !== null, c.taken);
      // Read from its text, as the server reads it: the same.
      assert.deepEqual(readCountText(JSON.stringify(c.count)), kept);
      if (kept === null) return;
      // What is kept is what came, member for member, and nothing more.
      const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
      assert.deepEqual(sorted(kept), sorted(c.count));
      // And in one order, whatever order it came in.
      assert.deepEqual(Object.keys(readCount(Object.fromEntries(Object.entries(c.count).reverse()))!), Object.keys(kept));
    });
  }

  for (const d of file.durations_of as { ms: number; took: string | null }[]) {
    test(`${d.ms} ms is ${d.took ?? "no duration"}`, () => assert.equal(tookOf(d.ms), d.took));
  }

  test("a time that is not a number is no duration", () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(tookOf(ms), null);
  });

  test("a text that is not JSON is dropped", () => {
    for (const text of ["", "{", "step", '{"client":"web"', "﻿{}"]) assert.equal(readCountText(text), null);
  });
});

describe("spec/counts.md lists the same table", () => {
  const document = new TextDecoder().decode(repoFile("spec/counts.md"));
  /** The rows of the table under a heading: the code of the first cell, and the clients of the second if it names any. */
  const rowsUnder = (heading: string): Map<string, string[] | null> => {
    const start = document.indexOf(`\n### ${heading}\n`);
    assert.notEqual(start, -1, `no heading "${heading}"`);
    const end = document.indexOf("\n##", start + 5);
    const rows = new Map<string, string[] | null>();
    for (const line of document.slice(start, end === -1 ? undefined : end).split("\n")) {
      const cells = /^\| `([a-z0-9_]+)` \|(?: ([a-z, ]+) \|)?/.exec(line);
      if (cells === null) continue;
      const clients = cells[2] === undefined ? null : cells[2].split(", ");
      rows.set(cells[1]!, clients !== null && clients.every((c) => (CLIENTS as readonly string[]).includes(c)) ? clients : null);
    }
    return rows;
  };
  const withClients: [string, Readonly<Record<string, readonly string[]>>][] = [
    ["Steps", STEPS],
    ["Reasons", REASONS],
    ["Actions of a card proof", CARD_PROOF_ACTIONS],
    ["Actions of a visitor", VISITOR_ACTIONS],
    ["Timed steps", TIMED_STEPS],
  ];
  for (const [heading, codes] of withClients) {
    test(`${heading}: each code and its clients, in the same order`, () => {
      assert.deepEqual([...rowsUnder(heading)], Object.entries(codes).map(([code, clients]) => [code, [...clients]]));
    });
  }
  const plain: [string, readonly string[]][] = [
    ["Clients", CLIENTS],
    ["Events", EVENTS],
    ["Pages", PAGES],
    ["Durations", DURATIONS],
    ["Sources", SOURCES],
    ["Browsers", BROWSERS],
    ["Operating systems", OSES],
  ];
  for (const [heading, codes] of plain) {
    test(`${heading}: each code, in the same order`, () => {
      assert.deepEqual([...rowsUnder(heading).keys()], [...codes]);
    });
  }
});
