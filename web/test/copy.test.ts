// The screen's text comes from design/copy/card-proof.json, the form of
// design/copy/card-proof.md a program can read. These tests keep the two the
// same, both ways:
//
//   - every entry of the JSON, with the example values the Markdown uses,
//     appears in the Markdown word for word (no sentence the document does
//     not have);
//   - every line of the Markdown's screens (its code blocks) and every cell
//     of its tables that the screen shows is made of JSON entries and
//     nothing else (no sentence of the document missing). Besides entries,
//     a line may hold the values the screen shows as they are (an account,
//     a date, the name on the card, a link, a platform's display name or ID,
//     the prefix from src/platforms.ts) and the marks the document draws
//     buttons, list items and expandable questions with.
//
// And no file of the screen has a sentence of its own: no CJK character in
// src/ui/ or in the HTML pages.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SITE_DOMAIN, cardPath, presentationOf } from "../src/platforms.ts";
import { type Copy, fill } from "../src/ui/copy.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const web = join(here, "..");
const md = readFileSync(join(web, "..", "design", "copy", "card-proof.md"), "utf8");
const copy = JSON.parse(readFileSync(join(web, "..", "design", "copy", "card-proof.json"), "utf8")) as Copy & Record<string, Record<string, string>>;

/** The values the Markdown's examples use ("例子裡的 … 是會換掉的值"). */
const EXAMPLES: Record<string, string> = {
  account: "@alice",
  last_declared: "@bob",
  previous: "@alice",
  name: "王小明",
  expiry_date: "2025-03-01",
  valid_from: "2026-12-01",
  crl_days: "5",
  code: "X",
  days_ago: "12",
  switches_used: "1",
  switches_left: "4",
  today: "2026-11-16",
  // done.recorded_on: the date of the record.
  date: "2026-11-16",
  // done.hung: the link in the sentence.
  open_proof: "打開你的島民證明",
  // confirm.holder_later: the words in bold.
  cannot_delete: "所有紀錄公開後無法刪除",
  short_id: "7K2Q9FM4XD",
  request_id: "3f9c2a7e5b1d4c80",
  step: "2",
  steps: "7",
  domain: SITE_DOMAIN,
  // done.share_text: the card's ordinal.
  ordinal: "128",
  // The one platform's name, where the screens speak of one platform.
  platform: "Threads",
  // The app's: the start date of the minimum version, the store, where the card goes, the seconds of computing.
  min_app_from: "2027-03-01",
  store: "App Store",
  spot: "手機背面的上方",
  seconds: "5",
  // done.mismatch_expected: the sentences of step 5's row (a switch, and that it is a correction).
  expected: "更換，原本是 @alice。今天才宣告的帳號，這次改掉不另外算一次更換。",
  // The app's reminder (step 6): the day and the time it is set for, about how far off, the day the certificate expires.
  day: "2027-02-08（星期一）",
  time: "晚上 9:00",
  interval: "三個月",
  valid_until: "2027-01-15",
};
/** Entries whose example in the Markdown differs from EXAMPLES. */
const OVERRIDES: Record<string, Record<string, string>> = {
  "stops.rejected": { code: "root" },
  "accounts.row_no_switches_yet": { switches_left: "5" },
  "accounts.row_used_up": { switches_used: "5" },
  "confirm.uses_switch": { switches_left: "1" },
  "accounts.switch_limit": { switches_left: "3" },
  // finish.switched: the account switched to, in the table of titles.
  "finish.switched": { account: "@carol.tw" },
};
/**
 * Values the screen shows on their own, not in a sentence: the example
 * accounts, date, name and link, the platforms' display names (from the
 * server's table; Threads and X in the examples), a platform ID and an
 * account shown as the server sent them (a platform the device does not
 * know), and the prefix of src/platforms.ts.
 */
/** The example link of the last screen, a value shown as it is. */
const LINK = `${SITE_DOMAIN}/${cardPath(EXAMPLES.short_id!)}`;
const VALUES = new Set([
  EXAMPLES.account!,
  "@alice_tw",
  "@carol.tw",
  "alice",
  "carol.tw",
  "alice-b",
  "test-example",
  EXAMPLES.today!,
  EXAMPLES.name!,
  LINK,
  "Threads",
  "X",
  presentationOf("threads")!.prefix,
]);
/** Entries that are not in card-proof.md on purpose. */
const NOT_IN_MD = new Set<string>();

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

/** The columns of the Markdown's tables that hold what the screen writes; the others describe the case. */
const SCREEN_COLUMNS = new Set(["畫面寫", "標題", "證明紀錄會公開記下", "按鈕"]);

/** The text the screens show: the lines of the code blocks, and the table cells of the screen's columns. */
function screenText(): string[] {
  const lines: string[] = [];
  // The code blocks are found in the Markdown as written (mdText has no backticks, so no fences).
  const blocks = [...md.matchAll(/^```\n([\s\S]*?)^```$/gm)].map((m) => m[1]!.replace(/`/g, ""));
  assert.ok(blocks.length >= 10, `card-proof.md: ${blocks.length} screens found`);
  for (const b of blocks) lines.push(...b.split("\n"));
  let columns: boolean[] | null = null;
  let tables = 0;
  for (const line of mdText.split("\n")) {
    if (!line.startsWith("|")) {
      columns = null;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (columns === null) {
      columns = cells.map((h) => SCREEN_COLUMNS.has(h)); // the header row
      assert.ok(columns.some(Boolean), `card-proof.md: a table with no column of the screen's text: ${line}`);
      tables++;
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    lines.push(...cells.filter((_, i) => columns![i]));
  }
  assert.ok(tables >= 4, `card-proof.md: ${tables} tables found`);
  return lines;
}

test("every sentence of the screens in card-proof.md is in card-proof.json", () => {
  // Longest first, so that a short entry does not cut a longer one apart.
  const rendered = entries()
    .filter(([key]) => !NOT_IN_MD.has(key))
    .map(([key, text]) => example(key, text))
    .sort((a, b) => b.length - a.length);
  for (const line of screenText()) {
    // Notes of the document, not text of the screen: where the QR code goes, a cell that points at another table.
    // The link first: the site's name in the header (common.site_name) is the start of it.
    let rest = line.replace(/（QR code）|第 2 步那張表裡同一種情況的句子/g, "").split(LINK).join(" ");
    for (const r of rendered) rest = rest.split(r).join(" ");
    // What may remain: bullets, the input boxes, the buttons' brackets, the arrows of
    // buttons and questions, the circles of list items, the numbers of numbered steps;
    // and values shown as they are.
    const left = rest
      .replace(/^[1-9]　/, " ")
      .replace(/[·[\]›▸○]/g, " ")
      .split(/\s+/)
      .filter((t) => t !== "" && !VALUES.has(t));
    assert.deepEqual(left, [], `card-proof.md: "${line}" is not made of card-proof.json's entries`);
  }
});

// The app's sentences are the groups whose name starts with "app_". The
// group "app" is the web page's: choosing a device and getting the app.
test("the app's sentences never say 這台裝置 or 這台電腦", () => {
  const app = entries().filter(([key]) => key.startsWith("app_"));
  assert.ok(app.length > 0, "card-proof.json has no app_ group");
  for (const [key, text] of app) assert.doesNotMatch(text, /這台裝置|這台電腦/, key);
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
