// Build of web/. Besides bundling, it makes the page load everything from its
// own origin (README.md, "Content-Security-Policy"):
//
// - bb.js ships its WebAssembly as data: URLs inside two JavaScript modules.
//   The build writes them out as files (bb/barretenberg.wasm.gz and
//   bb/barretenberg-threads.wasm.gz) and replaces the two modules with empty
//   ones; the engine passes bb.js the file's URL (`wasmPath`).
// - The compiled circuits (circuits/) and the CRS (crs/, fetched by
//   scripts/fetch-crs.mjs) are copied to the same paths in the build. The
//   page checks each against the SHA-256 in src/prover/artifacts.ts.
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

export default defineConfig({
  plugins: [noDataUrlWasm(), ownOriginAssets()],
  build: { target: "es2022", assetsInlineLimit: 0, sourcemap: false },
  // Worker bundles are built separately and need the plugin too.
  worker: { format: "es", plugins: () => [noDataUrlWasm()] },
  optimizeDeps: { exclude: ["@aztec-foundation/bb.js", "@noir-lang/noir_js"] },
});
