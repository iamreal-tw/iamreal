// The two files scripts/site-files.ts writes for the demonstration on the
// page of hanging a proof (design/copy/hang.md, 示範) are the ones their
// sources give: site/demo.js, the player the browser runs, and
// src/pages/hang-timeline.ts, the Worker's copy of design/motion/hang.json.
// Both are in the repository as written, since a deploy uploads site/ as it
// is checked out and runs no script of the repository.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO_FILE, HANG_TIMELINE_FILE, HANG_TIMELINE_SOURCE, demoScript, hangTimelineModule } from "../scripts/site-files.ts";
import { HANG_TIMELINE_JSON } from "../src/pages/hang-timeline.ts";
import { hangStateAt } from "../src/teaching-animation.ts";
import { WORKER_DIR } from "./build.ts";
import { difference, hangTimeline, vectors } from "./teaching-animation.ts";

/** Two versions of Node may leave other spaces where the types were: the text is compared without any. */
const unspaced = (text: string): string => text.replace(/\s+/g, "");

/** The two halves of the file: the states, whose types Node took off, and the player, which is written as it is. */
const PLAYER_STARTS = "// The player of the demonstration";
const halves = (script: string): [string, string] => {
  const cut = script.indexOf(PLAYER_STARTS);
  assert.ok(cut > 0, "the player starts where its comment says");
  return [script.slice(0, cut), script.slice(cut)];
};

test("site/demo.js is the one scripts/site-files.ts writes from src/teaching-animation.ts and demo/player.js", () => {
  const stale = "run `node --experimental-strip-types scripts/site-files.ts` after a change of either, and commit site/demo.js";
  const [states, player] = halves(readFileSync(join(WORKER_DIR, "site", DEMO_FILE), "utf8"));
  const [wantStates, wantPlayer] = halves(demoScript());
  assert.equal(unspaced(states), unspaced(wantStates), stale);
  // The player has no types to take off: character for character, spaces in its strings too.
  assert.equal(player, wantPlayer, stale);
});

test("the states site/demo.js computes are the answers of spec/vectors/teaching-animation.json", () => {
  // The file as the browser gets it, with the player cut off (it needs a page) and the function handed out.
  const [first, player] = halves(readFileSync(join(WORKER_DIR, "site", DEMO_FILE), "utf8"));
  const states = new Function(`${first.slice(first.indexOf("(() => {") + "(() => {".length)}; return hangStateAt;`)() as typeof hangStateAt;
  // The player half is a script too: it reads as one (what it does in a page is web/test/worker-card-proof.ts's to check).
  new Function(player.slice(0, player.lastIndexOf("})();")));
  const timeline = hangTimeline();
  const v = vectors();
  for (const c of v.hang) assert.equal(difference(states(timeline, c.variant, c.seconds), c.state, v.tolerance), null, `${c.name} (${c.seconds} s)`);
});

test("the Worker's copy of the timeline is design/motion/hang.json", () => {
  assert.equal(readFileSync(HANG_TIMELINE_FILE, "utf8"), hangTimelineModule());
  assert.deepEqual(JSON.parse(HANG_TIMELINE_JSON), JSON.parse(readFileSync(HANG_TIMELINE_SOURCE, "utf8")));
  // It goes into the page inside a data block: nothing in it may end one.
  assert.ok(!HANG_TIMELINE_JSON.includes("<"));
});
