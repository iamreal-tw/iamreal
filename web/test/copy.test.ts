// The screen's text comes from design/copy/card-proof.json, the form of
// design/copy/card-proof.md a program can read. These tests keep the two the
// same, both ways:
//
//   - every entry of the JSON, with the example values the Markdown uses,
//     appears in the Markdown word for word (no sentence the document does
//     not have);
//   - every line of the Markdown's screens (its code blocks) and every cell
//     of its tables that the screen shows is made of JSON entries and
//     nothing else (no sentence of the document missing).
//
// And no file of the screen has a sentence of its own: no CJK character in
// src/ui/ or in the HTML pages.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Copy, fill } from "../src/ui/copy.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const web = join(here, "..");
const md = readFileSync(join(web, "..", "design", "copy", "card-proof.md"), "utf8");
const copy = JSON.parse(readFileSync(join(web, "..", "design", "copy", "card-proof.json"), "utf8")) as Copy & Record<string, Record<string, string>>;

/** The values the Markdown's examples use ("例子裡的 … 是會換掉的值"). */
const EXAMPLES: Record<string, string> = {
  platform: "Threads",
  account: "alice",
  current: "bob",
  name: "王小明",
  expiry_date: "2025-03-01",
  valid_from: "2026-12-01",
  crl_days: "5",
  code: "X",
  days_ago: "12",
  switches_left: "1",
  next_switch_date: "2027-03-02",
  today: "2026-11-16",
  seq: "138",
  short_id: "7K2Q9F",
};
/** Entries whose example in the Markdown differs from EXAMPLES. */
const OVERRIDES: Record<string, Record<string, string>> = {
  "stops.rejected": { code: "root" },
};
/** Entries that are not in card-proof.md on purpose. */
const NOT_IN_MD = new Set(["not_in_card_proof_md.help_pending"]);

// The Markdown writes codes in backticks; the screen shows them without.
const mdText = md.replace(/`/g, "");

function entries(): [string, string][] {
  const out: [string, string][] = [];
  for (const [section, group] of Object.entries(copy)) {
    for (const [key, text] of Object.entries(group)) out.push([`${section}.${key}`, text]);
  }
  return out;
}

function example(key: string, text: string): string {
  return fill(text, { ...EXAMPLES, ...OVERRIDES[key] });
}

test("every entry of card-proof.json is in card-proof.md, word for word", () => {
  for (const [key, text] of entries()) {
    if (NOT_IN_MD.has(key)) continue;
    assert.equal(typeof text, "string", key);
    const placeholders = [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!);
    for (const p of placeholders) assert.ok(p in EXAMPLES, `${key}: no example for {${p}}`);
    assert.ok(mdText.includes(example(key, text)), `${key}: "${example(key, text)}" is not in card-proof.md`);
  }
});

/** The text the screens show: the lines of the code blocks, and the table cells after the first column. */
function screenText(): string[] {
  const lines: string[] = [];
  const blocks = [...mdText.matchAll(/^```\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);
  for (const b of blocks) lines.push(...b.split("\n"));
  let inTable = false;
  for (const line of mdText.split("\n")) {
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!inTable) {
      inTable = true; // the header row
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    lines.push(...cells.slice(1));
  }
  return lines;
}

test("every sentence of the screens in card-proof.md is in card-proof.json", () => {
  // Longest first, so that a short entry does not cut a longer one apart.
  const rendered = entries()
    .filter(([key]) => !NOT_IN_MD.has(key))
    .map(([key, text]) => example(key, text))
    .sort((a, b) => b.length - a.length);
  for (const line of screenText()) {
    // The notes in parentheses the document writes for a missing button are not text of the screen.
    let rest = line.replace(/（沒有按鈕）|（只有取消）/g, "");
    for (const r of rendered) rest = rest.split(r).join(" ");
    // What may remain: bullets, the input boxes, the buttons' brackets.
    rest = rest.replace(/[·\s[\]]/g, "");
    assert.equal(rest, "", `card-proof.md: "${line}" is not made of card-proof.json's entries (left: "${rest}")`);
  }
});

test("the screen's files hold no sentence of their own", () => {
  const cjk = /[　-〿㐀-鿿＀-￯]/;
  const files = [
    ...readdirSync(join(web, "src", "ui")).map((f) => join(web, "src", "ui", f)),
    ...readdirSync(web).filter((f) => f.endsWith(".html")).map((f) => join(web, f)),
  ];
  assert.ok(files.length > 3);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const line = text.split("\n").findIndex((l) => cjk.test(l));
    assert.equal(line, -1, `${f}:${line + 1} has CJK text; the screen's text comes from design/copy/card-proof.json`);
  }
});
