// The back end and the card the apps' card proof tests run against
// (android/, ios/): the Worker (worker/) in the local workerd, a fake MOICA,
// a card made of test keys. It runs the command it is given, a platform's
// tests in a simulator, then has Go's iamreal-verify re-verify the proof log
// those tests wrote. Nothing real: throwaway issuer keys, a throwaway card.
//
//   node --experimental-strip-types test/app-backend.ts <kinds> -- <command> [arguments]
//
// <kinds> is what the command's card proofs are to leave in the proof log, one
// record after the other, each the kind on Threads: for example
// `first,refresh,switch,withdraw`.
//
// 1. Makes throwaway issuer keys (G2, G3), a card with a signing and an
//    encryption certificate, and a CRL of each issuer (test/fixtures/).
// 2. Starts the Worker's test build (worker/test/harness.ts) with those
//    keys, and has its schedule mirror the two CRLs.
// 3. Puts a small server in front of it (e2e/worker-site.ts, the one the
//    browser tests use), in the place of both hosts an app talks to: the
//    site and the data domain. It also
//    takes `PUT /__app-test/clock` (an ISO time): from then on the Worker's
//    clock shows that time. The tests move it to the next day between card
//    proofs, as the back end writes at most 3 records of a card a day. And `PUT /__app-test/paused` (`true`
//    or `false`): from then on the operator has stopped taking card proofs,
//    or taken them again (`CARD_PROOFS_PAUSED`, worker/README.md, "停止和恢復
//    收過卡"), for the tests of #394's screens.
// 4. Writes test-output/app/backend.json, which the tests read from the
//    disk (a simulator sees the files of the machine it runs on), and
//    prints `listening on <origin>`. The file is removed when the command
//    ends:
//      origin        where the front server listens
//      now           the time the Worker's clock starts at (ISO)
//      issuers       the two issuer keys: issuer (G2, G3), modulus (hex)
//      certificates  what the card returns (DER, base64), in its order
//      signing       which of them signs
//      private_key   the card's key (PKCS #1 RSAPrivateKey, DER, base64)
//      pin           the card's PIN
// 5. Runs the command. It must exit 0.
// 6. Moves the Worker's clock to the midnight after the latest time it was
//    set to, has it publish the proof log, copies the bucket and runs
//    cmd/iamreal-verify on it (built with the tag iamrealtest, for the
//    throwaway issuer keys; the native bb named by IAMREAL_BB verifies
//    every proof): the proof log is valid, every record is, and the kinds are
//    <kinds>.
//
// The apps do not import worker/ (CLAUDE.md); what they share with this
// file is backend.json and HTTP.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { AUTHORITY_KEY_ID, KEY_USAGE_ENCRYPTION, SUBJECT_KEY_ID, buildTbs, certificate, name } from "./fixtures/certs.ts";
import { makeCrl } from "./fixtures/crls.ts";
import { hex, makeKey } from "./fixtures/der-build.ts";
import { randomSerials, testIssuerKeys } from "./fixtures/world.ts";
import { startWorkerSite } from "./e2e/worker-site.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const repo = join(web, "..");
const out = join(web, "test-output", "app");
const PIN = "834271";
const DAY_MS = 24 * 3600_000;
const TAIWAN_MS = 8 * 3600_000;

const split = process.argv.indexOf("--");
const kinds = split === 3 ? process.argv[2]!.split(",") : [];
const command = split === 3 ? process.argv.slice(split + 1) : [];
if (kinds.length === 0 || command.length === 0) {
  console.error("usage: app-backend.ts <kinds> -- <command> [arguments]");
  process.exit(2);
}
const BB = process.env.IAMREAL_BB;
if (BB === undefined) {
  console.error("IAMREAL_BB is not set: the bb 6.0.0 that iamreal-verify verifies the proofs with (verifier/README.md)");
  process.exit(2);
}

let failures = 0;
const check = (ok: boolean, what: string): boolean => {
  console.log(`${ok ? "ok    " : "FAIL  "} ${what}`);
  if (!ok) failures++;
  return ok;
};
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Keys, a card, CRLs ----------------------------------------------------------

const issuerKeys = await testIssuerKeys();
const issuers = [
  { name: "G2" as const, modulus: issuerKeys.G2.modulus.toString(16), bits: 2048 as const },
  { name: "G3" as const, modulus: issuerKeys.G3.modulus.toString(16), bits: 4096 as const },
];
const cardKey = await makeKey(2048);
const SERIAL = "1234567890abcdef1234567890abcdef";
const tbs = (serial: string, leading?: Uint8Array[]): Uint8Array => buildTbs({ spki: cardKey.spki, serial: hex(serial), subject: name("測試用戶"), leadingExtensions: leading });
const signing = await certificate(tbs(SERIAL), issuerKeys.G3);
const encryption = await certificate(tbs(`7${SERIAL.slice(1)}`, [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION]), issuerKeys.G3);
const privateKey = createPrivateKey({ key: Buffer.from(await crypto.subtle.exportKey("pkcs8", cardKey.privateKey)), format: "der", type: "pkcs8" }).export({ format: "der", type: "pkcs1" });
/** 09:00 today in Taiwan: the Worker's clock starts here, and the CRLs are dated the first second of that day. */
const today = new Date(Date.now() + TAIWAN_MS).toISOString().slice(0, 10);
const start = new Date(`${today}T09:00:00+08:00`);
const crlTime = new Date(`${today}T00:00:00+08:00`);
const crls = {
  G2: await makeCrl({ issuer: issuerKeys.G2, serials: randomSerials(2_000, 5n), crlNumber: 200n, thisUpdate: crlTime }),
  G3: await makeCrl({ issuer: issuerKeys.G3, serials: randomSerials(20_000, 3n), crlNumber: 300n, thisUpdate: crlTime }),
};

// 2. The Worker and its mirror -----------------------------------------------------

console.log("starting the Worker (test build)");
/** The latest time the Worker's clock was set to. */
let clock = start;
/** The body of a request the test answers itself. */
const bodyOf = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
};
/** The tests' own paths (3.), each taking PUT: what it does with the body, and the status to answer with (no body). */
const APP_TEST: Readonly<Record<string, (body: string) => Promise<number>>> = {
  "/__app-test/clock": async (body) => {
    const time = new Date(body);
    if (Number.isNaN(time.getTime())) return 400;
    await worker.setClock(time);
    if (time > clock) clock = time;
    return 204;
  },
  "/__app-test/paused": async (body) => {
    if (body !== "true" && body !== "false") return 400;
    await worker.setSettings(body === "true" ? { CARD_PROOFS_PAUSED: "true" } : {});
    return 204;
  },
};
const front = await startWorkerSite({
  issuers,
  own: async (req, res, path) => {
    const answer = APP_TEST[path];
    if (req.method !== "PUT" || answer === undefined) return false;
    res.writeHead(await answer(await bodyOf(req))).end();
    return true;
  },
});
// The tests' paths use it once the server is listening, after this line.
const worker = front.worker;

try {
  await worker.setClock(start);
  worker.moica.serve("G2", crls.G2);
  worker.moica.serve("G3", crls.G3);
  const round = await worker.runSchedule();
  check(round.outcome === "ok", `the Worker's schedule mirrored the two CRLs (${round.outcome})`);

  // 4. What the tests read ---------------------------------------------------------
  writeFileSync(
    join(out, "backend.json"),
    JSON.stringify({ origin: front.origin, now: start.toISOString(), issuers: issuers.map((i) => ({ issuer: i.name, modulus: i.modulus })), certificates: [b64(encryption), b64(signing)], signing: 1, private_key: b64(privateKey), pin: PIN }),
  );

  // 5. The tests -------------------------------------------------------------------
  console.log(`listening on ${front.origin}`);
  console.log(`running ${command.join(" ")}`);
  // Not spawnSync: the front server answers the command from this process.
  const ended = await new Promise<number | string>((done) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
    child.on("error", (e) => done(e.message));
    child.on("exit", (code, signal) => done(code ?? signal ?? "nothing"));
  });
  rmSync(join(out, "backend.json"));
  if (check(ended === 0, `the command ended with ${ended}`)) {
    // 6. Published, and re-verified ---------------------------------------------------
    const midnight = new Date(Math.floor((clock.getTime() + TAIWAN_MS) / DAY_MS + 1) * DAY_MS - TAIWAN_MS + 5_000);
    await worker.setClock(midnight);
    await worker.proofLog.runAlarm();
    const data = join(out, "data");
    for (const f of await worker.files()) {
      mkdirSync(dirname(join(data, f.key)), { recursive: true });
      writeFileSync(join(data, f.key), f.bytes);
    }
    const issuersDir = join(out, "issuers");
    mkdirSync(issuersDir);
    writeFileSync(join(issuersDir, "issuer-G2.der"), issuerKeys.G2.spki);
    writeFileSync(join(issuersDir, "issuer-G3.der"), issuerKeys.G3.spki);
    // bb verify reads only the first G1 point of the CRS, (1, 2) (spec/proof-verification.md, "The CRS").
    const crs = join(out, "crs");
    mkdirSync(crs);
    const point = Buffer.alloc(64);
    point[31] = 1;
    point[63] = 2;
    writeFileSync(join(crs, "bn254_g1.dat"), point);
    const verify = join(out, "iamreal-verify");
    execFileSync("go", ["build", "-tags", "iamrealtest", "-o", verify, "./cmd/iamreal-verify"], { cwd: repo, stdio: "inherit" });
    const run = spawnSync(verify, ["-bb", BB, "-crs", crs, "-proof-log", "test", "-json", "-test-issuers", issuersDir, "-data", data], { encoding: "utf8" });
    writeFileSync(join(out, "verify.json"), run.stdout);
    writeFileSync(join(out, "verify.txt"), run.stderr);
    if (check(run.status === 0, `iamreal-verify ended with ${run.status}${run.status === 0 ? "" : `: ${run.stderr.slice(-2000)}`}`)) {
      const v = JSON.parse(run.stdout) as { valid: boolean; results?: { valid: boolean; kinds?: { platform: string; kind: string }[] }[] };
      const written = (v.results ?? []).map((r) => (r.valid ? r.kinds!.map((k) => `${k.platform}:${k.kind}`).join("+") : "invalid"));
      check(v.valid && JSON.stringify(written) === JSON.stringify(kinds.map((k) => `threads:${k}`)), `iamreal-verify: the proof log is valid, and its records are ${JSON.stringify(written)}`);
    }
  }
} catch (e) {
  check(false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await front.close();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
