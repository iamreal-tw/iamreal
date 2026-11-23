// What must hold whatever the bucket does: every time the mirror tells the
// proof log's object of a root, the index in the bucket lists that root at
// that moment. The local workerd's bucket cannot be made to fail, so here
// the mirror (src/mirror.ts, `crlMirrorInWorker`) runs in Node over a
// stand-in for the bucket whose writes of the index can go wrong, and the
// check is made inside `tell`. The hash is a stand-in too: the roots are
// not what is tested.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import type { NewestCrls } from "../src/crl-index.ts";
import { makeCrl, testIssuers } from "./crls.ts";
import { sha256Hex } from "./proofs.ts";

// src/mirror.ts is written against the types of the Workers runtime
// (`R2Bucket`), which the tests' Node project does not have: it is loaded
// without its types, and what the test uses of it is spelled out here.
interface Mirror {
  round(): Promise<{ readonly errors: readonly string[] }>;
}
interface Parts {
  readonly sources: readonly { readonly issuer: "G2" | "G3"; readonly url: string }[];
  readonly bucket: Bucket;
  readonly timeoutMs: number;
  readonly catchUpMs: number;
  readonly issuers: ReturnType<typeof testIssuers>;
  readonly hash: (inputs: readonly Uint8Array[]) => Uint8Array;
  readonly tell: (newest: NewestCrls) => Promise<void>;
}
const MIRROR: string = "../src/mirror.ts";
const { crlMirrorInWorker } = (await import(MIRROR)) as { crlMirrorInWorker: (parts: Parts) => Mirror };

const INDEX = "crl/index.jsonl";
/** What a write of the index does: as usual, throw without writing, or write and then throw. */
type Fault = "throws" | "throws after writing" | undefined;

/** As much of an R2 bucket as the mirror uses. */
class Bucket {
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string; uploaded: Date }>();
  #stored = 0;
  indexWrites = 0;
  fault: (write: number) => Fault = () => undefined;

  set(key: string, value: Uint8Array | string): { etag: string } {
    const object = { bytes: typeof value === "string" ? new TextEncoder().encode(value) : value, etag: `etag-${++this.#stored}`, uploaded: new Date(1e12 + this.#stored * 1000) };
    this.objects.set(key, object);
    return object;
  }
  index(): string {
    return new TextDecoder().decode(this.objects.get(INDEX)?.bytes ?? new Uint8Array());
  }
  async get(key: string): Promise<{ etag: string; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { etag: object.etag, text: async () => new TextDecoder().decode(object.bytes), arrayBuffer: async () => object.bytes.slice().buffer as ArrayBuffer };
  }
  async head(key: string): Promise<object | null> {
    return this.objects.get(key) ?? null;
  }
  async list({ prefix }: { prefix: string }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean }> {
    return { objects: [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })), truncated: false };
  }
  async put(key: string, value: string | ArrayBuffer, options: { onlyIf?: Headers | { etagMatches: string } }): Promise<{ etag: string } | null> {
    const bytes = typeof value === "string" ? value : new Uint8Array(value);
    if (key !== INDEX) return this.set(key, bytes);
    const fault = this.fault(++this.indexWrites);
    if (fault === "throws") throw new Error("the bucket failed");
    const current = this.objects.get(INDEX);
    if (options.onlyIf instanceof Headers ? current !== undefined : options.onlyIf !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
    const written = this.set(key, bytes);
    if (fault === "throws after writing") throw new Error("the bucket answered too late");
    return written;
  }
}

const SOURCES = [{ issuer: "G2", url: "http://moica.test/g2" }, { issuer: "G3", url: "http://moica.test/g3" }] as const;
const THEN = new Date("2026-11-19T16:00:00Z");
const g2 = (number: bigint): Uint8Array => makeCrl({ issuer: "G2", number, thisUpdate: THEN, serials: [number] });
const g3 = (number: bigint): Uint8Array => makeCrl({ issuer: "G3", number, thisUpdate: THEN, serials: [number, number + 100n] });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A mirror over `bucket`; `told` gets every root told that the bucket's index did not list at that moment. */
function mirrorOver(bucket: Bucket, served: Record<string, Uint8Array>, told: { known: NewestCrls; unlisted: string[] }): Mirror {
  globalThis.fetch = (async (url: string) => new Response(served[url] as BodyInit, { status: 200 })) as typeof fetch;
  return crlMirrorInWorker({
    sources: SOURCES,
    bucket,
    timeoutMs: 5000,
    catchUpMs: 60_000,
    issuers: testIssuers(),
    hash: (inputs) => {
      const h = createHash("sha256");
      for (const input of inputs) h.update(input);
      const digest = new Uint8Array(h.digest());
      digest[0] = 0;
      return digest;
    },
    tell: async (newest) => {
      const index = bucket.index();
      for (const crl of [...newest.G2, ...newest.G3]) if (!index.includes(`"root":"${crl.root}"`)) told.unlisted.push(`CRL number ${crl.crlNumber}`);
      told.known = newest;
    },
  });
}

/** Two rounds in which the first write of the index does `fault`, after one round without trouble and after `between`. */
async function rounds(fault: Fault, between: (bucket: Bucket, first: { g2: Uint8Array; g3: Uint8Array }) => void = () => {}): Promise<{ bucket: Bucket; told: { known: NewestCrls; unlisted: string[] }; errors: string[][] }> {
  const bucket = new Bucket();
  const served: Record<string, Uint8Array> = {};
  const told = { known: { G2: [], G3: [] } as NewestCrls, unlisted: [] as string[] };
  const mirror = mirrorOver(bucket, served, told);
  const first = { g2: g2(1n), g3: g3(1n) };
  [served[SOURCES[0].url], served[SOURCES[1].url]] = [first.g2, first.g3];
  assert.deepEqual((await mirror.round()).errors, []);
  assert.deepEqual([told.known.G2.length, told.known.G3.length], [1, 1]);

  between(bucket, first);
  const writesBefore = bucket.indexWrites;
  bucket.fault = (write) => (write === writesBefore + 1 ? fault : undefined);
  const errors: string[][] = [];
  for (const number of [2n, 3n]) {
    [served[SOURCES[0].url], served[SOURCES[1].url]] = [g2(number), g3(number)];
    errors.push([...(await mirror.round()).errors]);
  }
  return { bucket, told, errors };
}

/** The line of G3's first CRL goes: its file is no longer in the bucket. */
const loseG3 = (bucket: Bucket, first: { g3: Uint8Array }): void => void bucket.objects.delete(`crl/${sha256Hex(first.g3)}.crl`);

for (const fault of ["throws", "throws after writing"] as const) {
  test(`a write of the index ${fault}: the proof log's object is never told of a root the index does not list`, async () => {
    const { told, bucket } = await rounds(fault);
    assert.deepEqual(told.unlisted, []);
    // And once the bucket works again, the object knows the newest two of each key.
    assert.deepEqual([told.known.G2.map((c) => c.crlNumber), told.known.G3.map((c) => c.crlNumber)], [["3", "2"], ["3", "2"]]);
    assert.equal(bucket.index().split("\n").length - 1, 6);
  });

  test(`a listed file is gone, and the write that takes its line out ${fault}: the same`, async () => {
    const { told } = await rounds(fault, loseG3);
    assert.deepEqual(told.unlisted, []);
    assert.deepEqual(told.known.G3.map((c) => c.crlNumber), ["3", "2"]);
  });
}
