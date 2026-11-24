// The visitors' style sheet (site/pages.css) against design/tokens.json:
// every value it sets is the token's of the same name, every colour comes
// from one, and the narrow layout starts where --breakpoint says
// (design/DESIGN.md, 數值怎麼用). Read from the file: what the browser is
// sent is checked in test/pages.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WORKER_DIR } from "./build.ts";

const tokens = JSON.parse(readFileSync(join(WORKER_DIR, "..", "design", "tokens.json"), "utf8")) as Record<string, string>;
const css = readFileSync(join(WORKER_DIR, "site", "pages.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is `:root`, by property. */
function rootValues(text: string): Map<string, string> {
  const m = /(^|\})\s*:root\s*\{([^}]*)\}/.exec(text);
  assert.ok(m, "the style sheet has a :root rule");
  const out = new Map<string, string>();
  for (const decl of m[2]!.split(";")) {
    if (decl.trim() === "") continue;
    const at = decl.indexOf(":");
    const name = decl.slice(0, at).trim();
    assert.ok(!out.has(name), `${name} is set once`);
    out.set(name, decl.slice(at + 1).trim());
  }
  return out;
}

test("every value :root sets is design/tokens.json's of the same name, and it sets the ones the sheet uses", () => {
  const root = rootValues(css);
  assert.ok(root.size > 10, "the check read :root");
  for (const [name, value] of root) {
    assert.ok(name in tokens, `${name} is not a token of design/tokens.json`);
    assert.equal(value, tokens[name], `${name}`);
  }
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!));
  for (const name of used) assert.ok(root.has(name), `${name} is used and not set in :root`);
  // A custom property is set nowhere but in :root: a value cannot drift from the token there.
  assert.equal([...css.matchAll(/(^|[{;\s])--[a-z0-9-]+\s*:/g)].length, root.size, "custom properties are set in :root only");
});

test("every colour is a token: no colour is written outside :root", () => {
  const outside = css.replace(/(^|\})\s*:root\s*\{[^}]*\}/, "$1");
  assert.deepEqual([...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(white|black|red|green|blue|teal)\b(?![-\w])/g)].map((m) => m[0]), []);
});

/** The media queries of the sheet but the one for reduced motion (the test below). */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

test("the narrow layout starts below --breakpoint", () => {
  const queries = [...css.matchAll(/@(media|container)\b([^{]*)\{/g)].map((m) => m[2]!.trim()).filter((q) => q !== REDUCED_MOTION);
  assert.ok(queries.length > 0, "the sheet has a narrow layout");
  for (const q of queries) assert.equal(q, `(width < ${tokens["--breakpoint"]})`, `@media ${q}`);
});

test("the one thing that moves by itself: the home page's 你 pulses --pulse-count times of --pulse-duration, then stops; still from the start for reduced motion", () => {
  // design/DESIGN.md, 動態. Every animation of the sheet, and every place one is set.
  const animations = [...css.matchAll(/([^{}]+)\{[^}]*?\banimation(-name)?\s*:\s*([^;}]+)/g)].map((m) => [m[1]!.trim(), m[3]!.trim()]);
  const moving = animations.filter(([, value]) => value !== "none");
  assert.equal(moving.length, 1, `one animation: ${JSON.stringify(animations)}`);
  const [selector, value] = moving[0]!;
  assert.match(selector!, /^body\.home .*\.pulse$/, "on the first screen's 你");
  const name = /^([a-z-]+) /.exec(value!)?.[1] ?? "";
  assert.deepEqual(value!.split(/\s+/).filter((w) => w.startsWith("var(")).sort(), ["var(--pulse-count)", "var(--pulse-duration)"], "its length and how many times, from the tokens");
  assert.match(css, new RegExp(`@keyframes ${name}\\s*\\{`), `the sheet has @keyframes ${name}`);
  // For reduced motion, the same element does not move at all.
  const reduced = new RegExp(`@media ${REDUCED_MOTION.replace(/[()]/g, "\\$&")}\\s*\\{\\s*${selector!.replace(/[.()]/g, "\\$&")}\\s*\\{\\s*animation:\\s*none;?\\s*\\}\\s*\\}`);
  assert.match(css, reduced, "reduced motion: no animation");
});

test("the headings' typeface is the subset the site sends, under the name --font-display gives first", () => {
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  assert.equal(faces.length, 1);
  const face = faces[0]!;
  const family = /^"([^"]+)"/.exec(tokens["--font-display"]!)![1]!;
  assert.match(face, new RegExp(`font-family:\\s*"${family}";`));
  assert.match(face, new RegExp(`font-weight:\\s*${tokens["--weight-heading"]};`));
  assert.match(face, /src:\s*url\("\/fonts\/GenRyuMin2TW-B\.woff2"\) format\("woff2"\);/);
  // The one address in the sheet is that file of this site.
  assert.deepEqual([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ['"/fonts/GenRyuMin2TW-B.woff2"']);
});
