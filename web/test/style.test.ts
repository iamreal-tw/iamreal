// The card proof page's style sheets (src/ui/style.css, and
// src/ui/test-proof-log.css, which the test site's build adds) against
// design/tokens.json: every value :root sets is the token's of the same
// name, every colour comes from one, and the narrow layout starts where
// --breakpoint says (design/DESIGN.md, 數值怎麼用). The headings' typeface is
// the subset of design/fonts/, which the build bundles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(join(web, "..", "design", "tokens.json"), "utf8")) as Record<string, string>;
const read = (file: string): string => readFileSync(join(web, "src", "ui", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const style = read("style.css");
const sheets = [style, read("test-proof-log.css")].join("\n");
const ROOT = /(^|\})\s*:root\s*\{([^}]*)\}/;

/** The declarations of the rule whose selector is `:root`, by property. */
function rootValues(text: string): Map<string, string> {
  const m = ROOT.exec(text);
  assert.ok(m, "style.css has a :root rule");
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

test("every value :root sets is design/tokens.json's of the same name, and it sets the ones the sheets use", () => {
  const root = rootValues(style);
  assert.ok(root.size > 10, "the check read :root");
  for (const [name, value] of root) {
    assert.ok(name in tokens, `${name} is not a token of design/tokens.json`);
    assert.equal(value, tokens[name], name);
  }
  for (const m of sheets.matchAll(/var\((--[a-z0-9-]+)\)/g)) assert.ok(root.has(m[1]!), `${m[1]} is used and not set in :root`);
  assert.equal([...sheets.matchAll(/(^|[{;\s])--[a-z0-9-]+\s*:/g)].length, root.size, "custom properties are set in style.css's :root only");
});

test("every colour is a token: no colour is written outside :root", () => {
  const outside = sheets.replace(ROOT, "$1");
  assert.deepEqual([...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(white|black|red|green|blue|teal)\b(?![-\w])/g)].map((m) => m[0]), []);
});

test("the narrow layout starts below --breakpoint", () => {
  const widths = [...sheets.matchAll(/@(media|container)\b([^{]*)\{/g)].map((m) => m[2]!.trim()).filter((q) => /width/.test(q));
  assert.ok(widths.length > 0, "the sheet has a narrow layout");
  for (const q of widths) assert.equal(q, `(width < ${tokens["--breakpoint"]})`, `@media ${q}`);
});

test("the headings' typeface is the subset of design/fonts/, under the name --font-display gives first", () => {
  const faces = [...sheets.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  assert.equal(faces.length, 1);
  const face = faces[0]!;
  const family = /^"([^"]+)"/.exec(tokens["--font-display"]!)![1]!;
  assert.match(face, new RegExp(`font-family:\\s*"${family}";`));
  assert.match(face, new RegExp(`font-weight:\\s*${tokens["--weight-heading"]};`));
  // A path the build resolves and bundles: the page loads it from its own origin, under /proof/assets/.
  assert.deepEqual([...sheets.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ['"../../../design/fonts/GenRyuMin2TW-B.woff2"']);
});
