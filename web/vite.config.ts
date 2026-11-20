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
// Modes (the pages' three are built for the path /proof/, `base`; engine for /):
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
// - engine: the engine's own headless test page (test/e2e/run.ts, its root).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vite";

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

/** In mode "test", src/target.ts is replaced by test/e2e/target.ts; in mode "localcard", by src/target-local.ts. */
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
  if (pages && mode !== "production" && mode !== "test" && mode !== "localcard") throw new Error(`vite mode ${mode}: production, test, localcard or engine`);
  return {
    // The pages are served under /proof/ (the card proof page at /proof, server/README.md); the
    // engine's own test page at /. src/base.ts reads it for the page's own paths.
    base: pages ? "/proof/" : "/",
    plugins: [noDataUrlWasm(), ownOriginAssets(), ...(mode === "test" ? [otherTarget(TEST_TARGET)] : mode === "localcard" ? [otherTarget(LOCAL_TARGET)] : [])],
    build: {
      target: "es2022",
      assetsInlineLimit: 0,
      sourcemap: false,
      ...(pages && { rollupOptions: { input: { index: join(here, "index.html"), help: join(here, "help.html") } } }),
    },
    // Worker bundles are built separately and need the plugin too.
    worker: { format: "es", plugins: () => [noDataUrlWasm()] },
    optimizeDeps: { exclude: ["@aztec-foundation/bb.js", "@noir-lang/noir_js"] },
  };
});
