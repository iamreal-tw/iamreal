// What the code of the pages (src/pages/) refuses to write, called directly in
// Node with the data a page is given: an account that is not a Threads
// username, a row of the history the page has no words for, the page of a
// short ID with no card. Each stops the page with an error rather than put
// the account in a link or an embed, leave a row blank, or write a page of
// nothing; the Worker answers 500 (README.md, 頁面和檔案). The Worker
// never gives a page such data (it reads the account in the address, and
// the views hold what the record rules wrote), so no request reaches these
// checks; the Go backend's test of the same (e159ab9:server/pages/pages_test.go,
// TestRenderAlone, its second half) called its pages directly too.
//
// Each refusal is next to the same page with the data a page is given,
// which is written: what stops the page is the one thing changed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseDay } from "iamreal-protocol/date.ts";

// The files of the pages are loaded by a path the type check of the tests
// does not follow: their types import src/page-data.ts, and through it the
// proof log's object, which only the Worker's own type check knows
// (README.md, 型別檢查). What this test gives them and reads back is
// written here: the fields of src/page-data.ts and src/pages/layout.ts it
// uses.
interface HistoryRow {
  readonly date: number;
  readonly platform: string;
  readonly kind: string;
  readonly afterWithdrawal: boolean;
  readonly before: string | null;
  readonly after: string | null;
}
interface PageCard {
  readonly scopedId: string;
  readonly firstCardProof: number;
  readonly lastCardProof: number;
  readonly cardProofs: number;
  readonly slots: readonly { readonly platform: string; readonly current: string | null; readonly switchCount: number }[];
  readonly history: readonly HistoryRow[];
}
interface Site {
  readonly testProofLogClearedOn: string | null;
  readonly host: string;
}
interface Document {
  readonly content: { toString(): string };
}
const load = async <T>(file: string): Promise<T> => (await import(new URL(`../src/pages/${file}`, import.meta.url).href)) as T;
const { accountPage } = await load<{ accountPage(username: string, data: { today: number; cards: readonly unknown[] }): Document }>("account.ts");
const { hangPage } = await load<{ hangPage(site: Site, short: string, account: string): Document }>("hang.ts");
const { proofPage } = await load<{ proofPage(site: Site, shortId: string, data: { today: number; cards: readonly PageCard[] }): Document }>("proof.ts");

const site: Site = { testProofLogClearedOn: "2026-11-07", host: "test.iamreal.tw" };
const today = parseDay("2026-11-18")!;
const SHORT = "7K2Q9FM4XD";
const SCOPED_ID = `${SHORT}${"0".repeat(42)}`;

/** Accounts that are not a Threads username in its one spelling: a capital letter, markup, the empty name. */
const NOT_NAMES = ["Alice", `a"/><script>`, ""];

/** A card whose account on Threads is `account`, declared on `today` with one record. */
function cardOf(account: string, history?: readonly HistoryRow[]): PageCard {
  return {
    scopedId: SCOPED_ID,
    firstCardProof: today,
    lastCardProof: today,
    cardProofs: 1,
    slots: [{ platform: "threads", current: account, switchCount: 0 }],
    history: history ?? [{ date: today, platform: "threads", kind: "first", afterWithdrawal: false, before: null, after: account }],
  };
}

describe("the page of an account", () => {
  test("is written for a Threads username", () => {
    assert.ok(accountPage("alice", { today, cards: [] }).content.toString().includes("@alice"));
  });
  for (const name of NOT_NAMES) {
    test(`is not written for ${JSON.stringify(name)}`, () => {
      assert.throws(() => accountPage(name, { today, cards: [] }), /^Error: pages: the account is not in the Threads format$/);
    });
  }
});

describe("the page to hang a proof", () => {
  test("is written for a Threads username", () => {
    assert.ok(hangPage(site, SHORT, "alice").content.toString().includes('href="https://www.threads.com/@alice"'));
  });
  for (const name of NOT_NAMES) {
    test(`is not written for ${JSON.stringify(name)}`, () => {
      assert.throws(() => hangPage(site, SHORT, name), /^Error: pages: the account is not in the Threads format$/);
    });
  }
});

describe("the page of a card", () => {
  test("is written for a card whose account is a Threads username, with a row the page has words for", () => {
    const page = proofPage(site, SHORT, { today, cards: [cardOf("alice")] }).content.toString();
    assert.ok(page.includes('src="https://www.threads.com/@alice/embed/"'));
    assert.ok(page.includes("新宣告：@alice"));
  });

  for (const name of NOT_NAMES.filter((n) => n !== "")) {
    test(`is not written for a card whose account is ${JSON.stringify(name)}`, () => {
      assert.throws(() => proofPage(site, SHORT, { today, cards: [cardOf(name)] }), /^Error: pages: a card has an account that is not a Threads username$/);
    });
    test(`is not written when one of several cards has ${JSON.stringify(name)}`, () => {
      const other = { ...cardOf(name), scopedId: `${SHORT}${"1".repeat(42)}` };
      assert.throws(() => proofPage(site, SHORT, { today, cards: [cardOf("alice"), other] }), /^Error: pages: a card has an account that is not a Threads username$/);
    });
  }

  test("is not written for a short ID with no card", () => {
    assert.throws(() => proofPage(site, SHORT, { today, cards: [] }), /^Error: pages: no card for the short ID$/);
  });

  /** Rows the page has no words for: a kind it does not know, and known kinds without the account their words name. */
  const NO_WORDS: [string, HistoryRow][] = [
    ["a kind it does not know", { date: today, platform: "threads", kind: "something new", afterWithdrawal: false, before: null, after: "alice" }],
    ["a first declaration of no account", { date: today, platform: "threads", kind: "first", afterWithdrawal: false, before: null, after: null }],
    ["a switch from no account", { date: today, platform: "threads", kind: "switch", afterWithdrawal: false, before: null, after: "alice" }],
    ["a withdrawal of no account", { date: today, platform: "threads", kind: "withdraw", afterWithdrawal: false, before: null, after: null }],
  ];
  for (const [what, row] of NO_WORDS) {
    test(`is not written with a row of the history that is ${what}`, () => {
      const first = cardOf("alice").history[0]!;
      assert.throws(() => proofPage(site, SHORT, { today, cards: [cardOf("alice", [row, first])] }), /^Error: pages: no words for a row of the history$/);
    });
  }
});
