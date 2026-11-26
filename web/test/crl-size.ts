// A measurement, not a test (`pnpm test` runs test/*.test.ts only): what
// reading a CRL file costs this reader, for files made to cost a reader as
// much as a file within the mirror's download limit can (#410; README.md,
// "讀清冊的記憶體"). Each file is read in a process of its own, as the page
// reads the CRL it downloaded (src/crl/crl.ts, `usableCrl`, under MOICA's
// first key), and the process reports:
//
//   - the time `usableCrl` takes;
//   - how far the process's peak resident memory rose from before the file
//     was read from disk to after `usableCrl` returned: the file's bytes
//     included, everything the reading allocated, collected or not; and,
//     apart, how much of it was reading the file from disk;
//   - what `usableCrl` made of the file.
//
//   node --experimental-strip-types test/crl-size.ts DIR
//
// DIR holds the files, for example those `go run
// ./crl/internal/crltest/makelarge -out DIR` writes.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Unusable, usableCrl } from "../src/crl/crl.ts";
import { MOICA_ISSUERS, importRsaKey } from "../src/issuers.ts";

interface Measured {
  readonly bytes: number;
  readonly ms: number;
  /** How far the peak rose while the file was read from disk. */
  readonly fileRiseBytes: number;
  /** How far the peak rose from before the file was read from disk to after `usableCrl` returned. */
  readonly peakRiseBytes: number;
  readonly result: string;
}

const MIB = 1024 * 1024;

/** In the child: read one file and print what was measured, as JSON. */
async function measureOne(path: string): Promise<void> {
  const issuer = MOICA_ISSUERS[0]!;
  const key = await importRsaKey(issuer.modulus, issuer.bits);
  // ru_maxrss: Node gives kilobytes on every platform.
  const peakBefore = process.resourceUsage().maxRSS * 1024;
  // One copy of the bytes, as the page holds the file it downloaded.
  const file: Uint8Array = readFileSync(path);
  const fileRiseBytes = process.resourceUsage().maxRSS * 1024 - peakBefore;
  const start = performance.now();
  let result: string;
  try {
    const usable = await usableCrl(file, key, issuer.bits);
    result = `usable, ${usable.count} keys`;
  } catch (e) {
    if (!(e instanceof Unusable)) throw e;
    result = e.code;
  }
  const ms = performance.now() - start;
  const peakRiseBytes = process.resourceUsage().maxRSS * 1024 - peakBefore;
  const measured: Measured = { bytes: file.length, ms, fileRiseBytes, peakRiseBytes, result };
  process.stdout.write(JSON.stringify(measured));
}

async function main(): Promise<void> {
  if (process.argv[2] === "--one") return measureOne(process.argv[3]!);
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: crl-size.ts DIR");
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".crl"))
    .map((f) => f.name)
    .sort();
  console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
  console.log("file                          bytes      read ms   peak rise MiB (of which reading the file from disk)   result");
  for (const name of names) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--one", join(dir, name)], { encoding: "utf8", maxBuffer: 64 * MIB });
    if (child.status !== 0) {
      console.log(`${name.padEnd(28)} failed: ${child.stderr.split("\n").slice(-5).join(" ")}`);
      continue;
    }
    const m = JSON.parse(child.stdout) as Measured;
    console.log(`${name.padEnd(28)} ${String(m.bytes).padStart(10)} ${m.ms.toFixed(0).padStart(10)} ${(m.peakRiseBytes / MIB).toFixed(1).padStart(15)} (${(m.fileRiseBytes / MIB).toFixed(1)})   ${m.result}`);
  }
}

await main();
