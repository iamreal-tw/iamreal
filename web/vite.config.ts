// Build of web/. Besides bundling, it makes the page load everything from its
// own origin, but the CRL archive, which is on the data domain of the build's
// target (README.md, "Content-Security-Policy" and "資料網域"):
//
// - bb.js ships its WebAssembly as data: URLs inside two JavaScript modules.
//   The build writes them out as files (bb/barretenberg.wasm.gz and
//   bb/barretenberg-threads.wasm.gz) and replaces the two modules with empty
//   ones; the engine passes bb.js the file's URL (`wasmPath`).
// - The compiled circuits (circuits/) and the CRS (crs/, fetched by
//   scripts/fetch-crs.mjs) are copied to the same paths in the build. The
//   page checks each against the SHA-256 in src/prover/artifacts.ts.
//
// Modes (the pages' four are built for the path /proof/, `base`; engine for /):
//
// - production (`pnpm build`): the page (index.html) and the help page
//   (help.html), with MOICA's issuer keys and component (src/target.ts).
// - test: the same pages, with test/e2e/target.ts in place of src/target.ts:
//   the test's issuer keys and fake component, which the caller passes as
//   `define` (test/e2e/ui.ts). test/build.test.ts checks that a production
//   build holds nothing of it.
// - localcard (`pnpm local`): the same pages, with src/target-local.ts in place
//   of src/target.ts: MOICA's issuer keys and component like production, but
//   the test roster's scope string and its platforms (a real card tried out
//   on this computer gets no scoped ID of the public roster).
// - testsite (`pnpm build:test-site`): the same pages, with
//   src/target-test-site.ts in place of src/target.ts: what test.iamreal.tw
//   serves. Like localcard, but the CRL archive comes from the test roster's
//   data domain, the link of the last screen is the test site's, and the
//   pages carry the mark of a test roster (design/copy/test-site.md) with
//   the date the roster was last cleared on: src/ui/test-roster.ts, an
//   entry this mode adds to the pages and no other mode has.
//   The date is the environment variable IAMREAL_TEST_ROSTER_CLEARED_ON,
//   YYYY-MM-DD: who builds for a deploy passes the one of the Worker's
//   settings (worker/wrangler.jsonc). Without it this mode is not built.
// - engine: the engine's own headless test page (test/e2e/run.ts, its root).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vite";
// By its path, not by the package's name: Vite bundles this file's relative imports before Node loads it, and
// leaves a package's to Node, which before 22.18 does not load a .ts file by itself.
import { type Roster, scopeOf } from "../protocol/src/scope.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The package's "require" entry is dest/node-cjs/index.js; the browser build is next to it.
const bbBrowser = join(dirname(require.resolve("@aztec-foundation/bb.js")), "..", "browser");
const BB_WASM_MODULES: Record<string, string> = {
  "barretenberg.js": "bb/barretenberg.wasm.gz",
  "barretenberg-threads.js": "bb/barretenberg-threads.wasm.gz",
};
const fetchCodeDir = join(bbBrowser, "barretenberg_wasm", "fetch_code", "browser");

function wasmOfModule(file: string): Uint8Array {
  const text = readFileSync(join(fetchCodeDir, file), "utf8");
  const m = /"data:application\/gzip;base64,([A-Za-z0-9+/=]+)"/.exec(text);
  if (!m) throw new Error(`no data: URL in bb.js ${file}`);
  return Buffer.from(m[1]!, "base64");
}

/** bb.js's two data: URL modules become empty; the page and the tree workers pass `wasmPath`. */
function noDataUrlWasm(): Plugin {
  return {
    name: "iamreal-no-data-url-wasm",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0]!;
      for (const name of Object.keys(BB_WASM_MODULES)) {
        if (file === join(fetchCodeDir, name)) return `export default "";`;
      }
      return null;
    },
  };
}

function ownOriginAssets(): Plugin {
  return {
    name: "iamreal-own-origin-assets",
    generateBundle() {
      for (const [name, out] of Object.entries(BB_WASM_MODULES)) {
        this.emitFile({ type: "asset", fileName: out, source: wasmOfModule(name) });
      }
      for (const f of readdirSync(join(here, "circuits")).filter((f) => f.endsWith(".json"))) {
        this.emitFile({ type: "asset", fileName: `circuits/${f}`, source: readFileSync(join(here, "circuits", f)) });
      }
      const crs = join(here, "crs");
      if (!existsSync(crs)) {
        this.warn("crs/ is missing: run `node scripts/fetch-crs.mjs`; the page cannot prove without it");
        return;
      }
      for (const f of readdirSync(crs).filter((f) => f.endsWith(".dat"))) {
        this.emitFile({ type: "asset", fileName: `crs/${f}`, source: readFileSync(join(crs, f)) });
      }
    },
  };
}

const TARGET = join(here, "src", "target.ts");
const TEST_TARGET = join(here, "test", "e2e", "target.ts");
const LOCAL_TARGET = join(here, "src", "target-local.ts");
const TEST_SITE_TARGET = join(here, "src", "target-test-site.ts");
const OTHER_TARGETS: Record<string, string> = { test: TEST_TARGET, localcard: LOCAL_TARGET, testsite: TEST_SITE_TARGET };

/** The scope strings of spec/scope.md, as protocol/src/scope.ts has them. */
const TEST_SCOPE = "iamreal-test:public:0__________";

/**
 * The mark of a test roster for the test site's build, as the JSON text
 * src/ui/test-roster.ts reads: the sentence of design/copy/test-site.md up
 * to its example date; the date of IAMREAL_TEST_ROSTER_CLEARED_ON, which
 * must be a date of the calendar; and the scope string the build's target
 * (src/target-test-site.ts, its `ROSTER` read here) has the card sign, which must be
 * the test roster's: this mode is not built with a target of the public
 * roster.
 */
function testRosterMark(): string {
  const clearedOn = process.env.IAMREAL_TEST_ROSTER_CLEARED_ON ?? "";
  const [y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clearedOn)?.slice(1).map(Number) ?? [];
  const date = y === undefined ? null : new Date(Date.UTC(y, m! - 1, d));
  if (date === null || date.getUTCFullYear() !== y || date.getUTCMonth() !== m! - 1 || date.getUTCDate() !== d) {
    throw new Error(`vite mode testsite: IAMREAL_TEST_ROSTER_CLEARED_ON must be the date the test roster was last cleared on, YYYY-MM-DD; it is ${JSON.stringify(clearedOn)}`);
  }
  const copy = readFileSync(join(here, "..", "design", "copy", "test-site.md"), "utf8");
  const sentence = /```\n(.*)\d{4}-\d{2}-\d{2}\n```/.exec(copy)?.[1];
  if (sentence === undefined) throw new Error("design/copy/test-site.md: no sentence that ends with a date in its first block");
  // The roster of the target, read from its one line: the file is not loaded here (it imports the whole engine,
  // by package names Node before 22.18 cannot load from a .ts file). A line written another way is no roster.
  const roster = /^export const ROSTER: Roster = "(production|test)";$/m.exec(readFileSync(TEST_SITE_TARGET, "utf8"))?.[1] as Roster | undefined;
  if (roster === undefined) throw new Error('vite mode testsite: src/target-test-site.ts has no line `export const ROSTER: Roster = "test";`');
  const scope = scopeOf(roster);
  if (scope !== TEST_SCOPE) throw new Error(`vite mode testsite: src/target-test-site.ts has the card sign ${scope}, not the test roster's ${TEST_SCOPE}`);
  return JSON.stringify({ sentence, clearedOn, scope });
}

/** Adds the mark's script (src/ui/test-roster.ts) to both pages, before Vite reads their scripts: an entry only this mode's build has. */
function testRosterEntry(): Plugin {
  return {
    name: "iamreal-test-roster-mark",
    transformIndexHtml: { order: "pre", handler: () => [{ tag: "script", attrs: { type: "module", src: "/src/ui/test-roster.ts" }, injectTo: "head" }] },
  };
}

/** In mode "test", src/target.ts is replaced by test/e2e/target.ts; in mode "localcard", by src/target-local.ts; in mode "testsite", by src/target-test-site.ts. */
function otherTarget(replacement: string): Plugin {
  return {
    name: "iamreal-other-target",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      return r && r.id === TARGET ? replacement : null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const pages = mode !== "engine";
  if (pages && mode !== "production" && !Object.hasOwn(OTHER_TARGETS, mode)) throw new Error(`vite mode ${mode}: production, test, localcard, testsite or engine`);
  return {
    // The pages are served under /proof/ (the card proof page at /proof, worker/README.md "Static Assets"); the
    // engine's own test page at /. src/base.ts reads it for the page's own paths.
    base: pages ? "/proof/" : "/",
    plugins: [noDataUrlWasm(), ownOriginAssets(), ...(Object.hasOwn(OTHER_TARGETS, mode) ? [otherTarget(OTHER_TARGETS[mode]!)] : []), ...(mode === "testsite" ? [testRosterEntry()] : [])],
    // The JSON text, as a string in the script: JSON.stringify twice.
    ...(mode === "testsite" && { define: { __IAMREAL_TEST_ROSTER_MARK__: JSON.stringify(testRosterMark()) } }),
    build: {
      target: "es2022",
      assetsInlineLimit: 0,
      sourcemap: false,
      ...(pages && { rollupOptions: { input: { index: join(here, "index.html"), help: join(here, "help.html") } } }),
    },
    // Worker bundles are built separately and need the plugin too.
    worker: { format: "es" as const, plugins: () => [noDataUrlWasm()] },
    optimizeDeps: { exclude: ["@aztec-foundation/bb.js", "@noir-lang/noir_js"] },
  };
});
