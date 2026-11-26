// The operator's query of the connection log (scripts/connection-log.ts,
// #417) against the local Worker's connection log bucket: made-up entries,
// in the back end's form (src/connection-log.ts, entryOf and keyOf; that
// file needs the Workers runtime's types, so the form is written again here)
// with addresses of the ranges kept for documentation (RFC 5737, RFC 3849),
// found by time, by result, by IP address and by card proof device ID, and
// only those. Then the way to the real bucket, with no real key: the
// signature against AWS's examples, the key file, and R2's S3 API answered
// by a stand-in.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BUCKET, CONNECTION_LOG_PREFIX, type Entry, type Query, type Store, authorization, daysOf, keysIn, lineOf, query, queryOf, r2Store } from "../scripts/connection-log.ts";
import { type TestWorker, startWorker } from "./harness.ts";

let worker: TestWorker;

const A = "203.0.113.7";
const B = "198.51.100.23";
const V6 = "2001:db8::42";
const PHONE = "0123456789abcdef0123456789abcdef";
const LAPTOP = "fedcba9876543210fedcba9876543210";

/** A made-up entry, in the keys and the order entryOf writes them (src/connection-log.ts). */
function made(time: string, id: string, ip: string, device: string | null, end: { status: number; seq: number } | { status: number; error: string }): Entry {
  const head = { request_id: id, time, result: end.status };
  const from = { ip, country: null, asn: null, device_id: device };
  return "seq" in end ? { ...head, ...from, seq: end.seq } : { ...head, error: end.error, ...from, body: '{"made":"up"}' };
}
/** Its key, as keyOf makes it. */
const keyOf = (e: Entry): string => `${CONNECTION_LOG_PREFIX}${e.time.slice(0, 10)}/${e.time}-${e.request_id}.json`;

const ENTRIES: readonly Entry[] = [
  made("2026-11-19T23:59:59.000Z", "0000000000000001", A, PHONE, { status: 201, seq: 7 }),
  made("2026-11-20T03:00:00.000Z", "0000000000000002", A, PHONE, { status: 409, error: "challenge_used" }),
  made("2026-11-20T08:30:00.000Z", "0000000000000003", B, LAPTOP, { status: 201, seq: 8 }),
  made("2026-11-20T08:45:00.000Z", "0000000000000004", V6, null, { status: 422, error: "proof" }),
  made("2026-11-21T00:00:00.000Z", "0000000000000005", B, PHONE, { status: 201, seq: 9 }),
  made("2026-11-22T12:00:00.000Z", "0000000000000006", A, LAPTOP, { status: 201, seq: 10 }),
];

before(async () => {
  worker = await startWorker();
  await worker.emptyConnectionLog();
  // Written out of order: the query lists each day's keys, and sorts what it found.
  for (const e of [...ENTRIES].reverse()) await worker.putInConnectionLogBucket(keyOf(e), JSON.stringify(e));
  // Something else in the bucket, not under connection/: never read.
  await worker.putInConnectionLogBucket("counts/2026-11-20/x.json", '{"not":"an entry"}');
});
after(() => worker.close());

/** The local bucket, as the command reads the real one. */
const store: Store = {
  async keys(prefix) {
    return (await worker.connectionLog()).map((o) => o.key).filter((k) => k.startsWith(prefix)).sort();
  },
  async text(key) {
    return (await worker.connectionLog()).find((o) => o.key === key)?.text ?? null;
  },
};

const ids = async (q: Partial<Query>): Promise<string[]> => (await query(store, { from: "2026-11-19", to: "2026-11-22", ...q })).map((e) => e.request_id.slice(-1));

test("by days: the UTC days of the range, both ends included, oldest first", async () => {
  assert.deepEqual(await ids({}), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(await ids({ from: "2026-11-20", to: "2026-11-20" }), ["2", "3", "4"]);
  assert.deepEqual(await ids({ from: "2026-11-23", to: "2026-11-25" }), []);
});

test("by time: at or after --after, before --before, whatever the zone they are written in", async () => {
  assert.deepEqual(await ids({ after: "2026-11-20T08:30:00Z", before: "2026-11-21T00:00:00Z" }), ["3", "4"]);
  // 16:30 in Taiwan is 08:30 UTC.
  assert.deepEqual(await ids({ after: "2026-11-20T16:30:00+08:00", before: "2026-11-20T16:45:00+08:00" }), ["3"]);
  await assert.rejects(query(store, { from: "2026-11-20", to: "2026-11-20", after: "2026-11-20 08:30" }), /a time is ISO with its zone/);
  await assert.rejects(query(store, { from: "2026-11-20", to: "2026-11-20", after: "2026-13-01T00:00Z" }), /a time is ISO with its zone/, "a month that is not one");
});

test("by result: accepted, refused, a status, an error code", async () => {
  assert.deepEqual(await ids({ result: "accepted" }), ["1", "3", "5", "6"]);
  assert.deepEqual(await ids({ result: "refused" }), ["2", "4"]);
  assert.deepEqual(await ids({ result: "409" }), ["2"]);
  assert.deepEqual(await ids({ result: "proof" }), ["4"]);
  assert.deepEqual(await ids({ result: "daily_limit" }), []);
});

test("by IP address: exactly that address, IPv4 or IPv6", async () => {
  assert.deepEqual(await ids({ ip: A }), ["1", "2", "6"]);
  assert.deepEqual(await ids({ ip: V6 }), ["4"]);
  assert.deepEqual(await ids({ ip: "203.0.113.70" }), [], "not a prefix");
  assert.deepEqual(await ids({ ip: "2001:DB8:0:0::42" }), ["4"], "IPv6 in another spelling");
  assert.deepEqual(await ids({ ip: A, result: "accepted", from: "2026-11-20", to: "2026-11-22" }), ["6"], "the conditions together");
});

test("by card proof device ID (#431): its submissions, each with the time, result, IP address, and the record's seq when it became one", async () => {
  const phone = await query(store, { from: "2026-11-19", to: "2026-11-22", device: PHONE });
  assert.deepEqual(
    phone.map((e) => [e.time, e.result, e.ip, e.seq ?? null]),
    [
      ["2026-11-19T23:59:59.000Z", 201, A, 7],
      ["2026-11-20T03:00:00.000Z", 409, A, null],
      ["2026-11-21T00:00:00.000Z", 201, B, 9],
    ],
  );
});

test("a line: the entry without its body, unless asked", async () => {
  const [refused] = (await query(store, { from: "2026-11-20", to: "2026-11-20", result: "challenge_used" })) as Entry[];
  assert.ok(refused !== undefined);
  assert.ok(!("body" in JSON.parse(lineOf(refused, false))));
  assert.equal(JSON.parse(lineOf(refused, true)).body, '{"made":"up"}');
});

test("what it does not take: a range longer than the log keeps, a date that is not one, an argument it does not know, an object that is not an entry", async () => {
  assert.throws(() => daysOf("2026-10-01", "2026-11-20"), /at most 33 days/);
  assert.throws(() => daysOf("2026-11-31", "2026-12-01"), /dates, YYYY-MM-DD/);
  assert.throws(() => daysOf("2026-11-21", "2026-11-20"), /before --from/);
  assert.deepEqual(queryOf(["--from", "2026-11-20", "--to", "2026-11-21", "--ip", A, "--body"]), { query: { from: "2026-11-20", to: "2026-11-21", ip: A }, body: true });
  assert.throws(() => queryOf(["--from", "2026-11-20"]), /--from and --to are needed/);
  assert.throws(() => queryOf(["--from", "2026-11-20", "--to", "2026-11-21", "--name", "x"]), /not an argument this takes/);
  await worker.putInConnectionLogBucket("connection/2026-11-23/broken.json", '{"not":"an entry"}');
  await assert.rejects(query(store, { from: "2026-11-23", to: "2026-11-23" }), /connection\/2026-11-23\/broken\.json is not an entry/);
});

test("the prefix and the bucket are the back end's", () => {
  const source = readFileSync(new URL("../src/connection-log.ts", import.meta.url), "utf8");
  assert.ok(source.includes(`export const CONNECTION_LOG_PREFIX = "${CONNECTION_LOG_PREFIX}";`), "src/connection-log.ts's prefix");
  assert.ok(source.includes("export const keyOf = (entry: ConnectionLogEntry): string => `${CONNECTION_LOG_PREFIX}${entry.time.slice(0, 10)}/${entry.time}-${entry.request_id}.json`;"), "src/connection-log.ts's keys, as made here");
  assert.match(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), new RegExp(`"binding": "CONNECTION_LOG", "bucket_name": "${BUCKET}"`));
});

// The examples of https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html: their keys, bucket and date.
const AWS_KEYS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("the signature: AWS's examples of a GET of an object and of a list of objects", () => {
  assert.equal(
    authorization(
      { method: "GET", path: "/test.txt", query: [], headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" }, payloadHash: EMPTY },
      AWS_KEYS,
      "us-east-1",
    ),
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(
    authorization(
      { method: "GET", path: "/", query: [["max-keys", "2"], ["prefix", "J"]], headers: { host: "examplebucket.s3.amazonaws.com", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" }, payloadHash: EMPTY },
      AWS_KEYS,
      "us-east-1",
    ),
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
});

test("the key file: none, another user able to read it, a name missing; the error says where to read how, and nothing the file holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "connection-log-keys-"));
  try {
    const file = join(dir, "connection-log.env");
    assert.throws(() => keysIn(file), (e: Error) => e.message === `no key file at ${file}: how to make the token and this file is in worker/README.md「查連線紀錄」`);
    const secret = "S3CRET-made-up-0123456789";
    writeFileSync(file, `R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef\nR2_ACCESS_KEY_ID=made-up-id\nR2_SECRET_ACCESS_KEY=${secret}\n`);
    chmodSync(file, 0o644);
    assert.throws(() => keysIn(file), (e: Error) => /can be read or written by other users of this computer: chmod 600 it/.test(e.message) && !e.message.includes(secret));
    chmodSync(dir, 0o700);
    assert.throws(() => keysIn(dir), (e: Error) => e.message === `cannot read ${dir} (EISDIR): worker/README.md「查連線紀錄」`, "a directory where the file should be: said by its code");
    chmodSync(file, 0o600);
    assert.deepEqual(keysIn(file), { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "made-up-id", secretAccessKey: secret });
    writeFileSync(file, `R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef\nR2_SECRET_ACCESS_KEY=${secret}\n`);
    chmodSync(file, 0o600);
    assert.throws(() => keysIn(file), (e: Error) => e.message.endsWith("has no R2_ACCESS_KEY_ID (worker/README.md「查連線紀錄」)") && !e.message.includes(secret));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2's S3 API, answered by a stand-in: signed GETs of the bucket's address, a list over two pages, an object, one gone", async () => {
  const keys = { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "made-up-id", secretAccessKey: "made-up-secret" };
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const page = (keys: string[], next?: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>${next !== undefined}</IsTruncated>${next !== undefined ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const u = new URL(url);
    if (u.pathname === `/${BUCKET}` && u.searchParams.get("continuation-token") === null) return new Response(page(["connection/2026-11-20/a.json"], "t&2"));
    if (u.pathname === `/${BUCKET}`) return new Response(page(["connection/2026-11-20/b.json"]));
    if (u.pathname.endsWith("/a.json")) return new Response('{"x":1}');
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const store = r2Store(keys, BUCKET, fetchFn);
  assert.deepEqual(await store.keys("connection/2026-11-20/"), ["connection/2026-11-20/a.json", "connection/2026-11-20/b.json"]);
  assert.equal(await store.text("connection/2026-11-20/a.json"), '{"x":1}');
  assert.equal(await store.text("connection/2026-11-20/b.json"), null, "gone since it was listed");
  assert.equal(asked[0]!.url, `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/${BUCKET}?list-type=2&prefix=connection%2F2026-11-20%2F`);
  assert.match(asked[1]!.url, /&continuation-token=t%262$/, "the second page asked with the token, unescaped from the XML");
  for (const a of asked) {
    assert.match(a.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=made-up-id\/\d{8}\/auto\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(a).includes("made-up-secret"), "the secret is in no request");
  }
});
