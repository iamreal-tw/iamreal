// A measurement, not a test (`pnpm test` runs test/*.test.ts only): reading
// CRL files made to cost a reader as much as a file within the mirror's
// download limit can (#120; README.md, "清冊鏡像量到的"). Each file is read
// in a process of its own, as the mirror reads one file of the archive
// (src/crl.ts, under MOICA's two keys), and the process reports:
//
//   - the time `readCrl` takes;
//   - how far the process's peak resident memory rose from before the file
//     was read from disk to after `readCrl` returned: the file's bytes
//     included, everything the reading allocated, collected or not; and,
//     apart, how much of it was reading the file from disk;
//   - the file's line of the archive index.
//
//   node --experimental-strip-types test/crl-size.ts DIR [INDEX]
//
// DIR holds the files, for example those `go run
// ./crl/internal/crltest/makelarge -out DIR` writes. INDEX, if given, gets
// the index of the files, as src/crl-index.ts writes it, to compare with
// what the Go `iamreal-crl index DIR` prints: the two must be the same bytes.
// A file that is usable has its line written without a tree (none of the
// files makelarge writes is).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCrl } from "../src/crl.ts";
import { type IndexLine, formatIndex, lineOf } from "../src/crl-index.ts";
import { MOICA_ISSUERS } from "../src/issuers.ts";

interface Measured {
  readonly bytes: number;
  readonly ms: number;
  /** How far the peak rose while the file was read from disk. */
  readonly fileRiseBytes: number;
  /** How far the peak rose from before the file was read from disk to after `readCrl` returned. */
  readonly peakRiseBytes: number;
  readonly line: IndexLine;
}

const MIB = 1024 * 1024;

/** In the child: read one file and print what was measured, as JSON. */
async function measureOne(path: string): Promise<void> {
  // ru_maxrss: Node gives kilobytes on every platform.
  const peakBefore = process.resourceUsage().maxRSS * 1024;
  // One copy of the bytes, as the mirror holds the file it read from the bucket.
  const file: Uint8Array = readFileSync(path);
  const fileRiseBytes = process.resourceUsage().maxRSS * 1024 - peakBefore;
  const start = performance.now();
  const reading = await readCrl(file, MOICA_ISSUERS);
  const ms = performance.now() - start;
  const peakRiseBytes = process.resourceUsage().maxRSS * 1024 - peakBefore;
  const sha256 = createHash("sha256").update(file).digest("hex");
  const line = lineOf(sha256, reading, reading.keys === undefined ? undefined : new Uint8Array(32));
  const measured: Measured = { bytes: file.length, ms, fileRiseBytes, peakRiseBytes, line };
  process.stdout.write(JSON.stringify(measured));
}

async function main(): Promise<void> {
  if (process.argv[2] === "--one") return measureOne(process.argv[3]!);
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: crl-size.ts DIR [INDEX]");
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && !f.name.startsWith(".") && f.name !== "index.jsonl")
    .map((f) => f.name)
    .sort();
  const lines: IndexLine[] = [];
  console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
  console.log("file                          bytes      read ms   peak rise MiB (of which reading the file from disk)   root");
  for (const name of names) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--one", join(dir, name)], { encoding: "utf8", maxBuffer: 64 * MIB });
    if (child.status !== 0) {
      console.log(`${name.padEnd(28)} failed: ${child.stderr.split("\n").slice(-5).join(" ")}`);
      continue;
    }
    const m = JSON.parse(child.stdout) as Measured;
    lines.push(m.line);
    console.log(`${name.padEnd(28)} ${String(m.bytes).padStart(10)} ${m.ms.toFixed(0).padStart(10)} ${(m.peakRiseBytes / MIB).toFixed(1).padStart(15)} (${(m.fileRiseBytes / MIB).toFixed(1)})   ${m.line.root.slice(0, 32)} crl_number ${m.line.crlNumber.slice(0, 20)}${m.line.crlNumber.length > 20 ? "…" : ""}`);
  }
  if (process.argv[3] !== undefined) writeFileSync(process.argv[3], formatIndex(lines));
}

await main();
