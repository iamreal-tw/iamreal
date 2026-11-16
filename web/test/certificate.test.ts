// The certificate checks before the PIN (certificate.ts): the circuit's walk,
// validity on today's date in Taiwan, the issuer's signature, and choosing
// the certificate among those on the card.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { concatBytes } from "../src/bytes.ts";
import { selectCertificate, walkTbs } from "../src/certificate.ts";
import { parseDay } from "../src/spec/date.ts";
import {
  AUTHORITY_KEY_ID,
  CERT_POLICIES,
  KEY_USAGE_ENCRYPTION,
  KEY_USAGE_SIGNING,
  SUBJECT_KEY_ID,
  buildTbs,
  cardHolderRank,
  certificate,
  name,
  subjectDirectoryAttributes,
} from "./fixtures/certs.ts";
import { makeKey } from "./fixtures/der-build.ts";
import { testIssuerKeys } from "./fixtures/world.ts";

const today = parseDay("2026-11-16")!;

describe("certificates", async () => {
  const keys = await testIssuerKeys();
  const card = await makeKey(2048);
  const issuers = [
    { name: "G2" as const, modulus: keys.G2.modulus, bits: 2048 as const },
    { name: "G3" as const, modulus: keys.G3.modulus, bits: 4096 as const },
  ];
  const cert = (o: Partial<Parameters<typeof buildTbs>[0]> = {}, issuer = keys.G3) => certificate(buildTbs({ spki: card.spki, ...o }), issuer);
  const select = async (...ders: Uint8Array[]) => selectCertificate(ders, today, issuers);

  test("a citizen's primary-card signing certificate passes; issuer, serial, key and name are read", async () => {
    const r = await select(await cert());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.cert.issuer.name, "G3");
    assert.equal(r.cert.serial, 0x1234567890abcdef1234567890abcdefn);
    assert.equal(r.cert.cardModulus, card.modulus);
    assert.equal(r.cert.name, "測試用戶");
    assert.equal(r.cert.notAfter, 310101155959n);
  });
  test("G2 issuer", async () => {
    const r = await select(await cert({}, keys.G2));
    assert.equal(r.ok && r.cert.issuer.name, "G2");
  });
  test("the signing certificate is chosen over the encryption one, in either order", async () => {
    const enc = await cert({ leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION], serial: Uint8Array.of(9) });
    const sig = await cert();
    for (const order of [[enc, sig], [sig, enc]]) {
      const r = await select(...order);
      assert.equal(r.ok && r.cert.serial, 0x1234567890abcdef1234567890abcdefn);
    }
  });
  test("only an encryption certificate", async () => {
    const r = await select(await cert({ leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION] }));
    assert.deepEqual(r, { ok: false, problem: "unsupported_format" });
  });
  test("no certificate", async () => assert.deepEqual(await select(), { ok: false, problem: "no_certificate" }));
  test("two different signing certificates: no choice", async () => {
    const r = await select(await cert(), await cert({ serial: Uint8Array.of(7) }));
    assert.deepEqual(r, { ok: false, problem: "ambiguous_certificate" });
  });
  test("expired yesterday (Taiwan), with its date", async () => {
    // notAfter 2026-11-15 15:59:59 UTC is the last second of 2026-11-15 in Taiwan.
    const r = await select(await cert({ notAfter: "261115155959Z" }));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.problem, "expired");
      assert.equal(r.notAfter, 261115155959n);
    }
  });
  test("valid through the last second of today", async () => {
    assert.equal((await select(await cert({ notAfter: "261116155959Z" }))).ok, true);
  });
  test("not yet valid", async () => {
    const r = await select(await cert({ notBefore: "261117000000Z" }));
    assert.equal(!r.ok && r.problem, "not_yet_valid");
  });
  test("a foreign resident's certificate", async () => {
    const r = await select(await cert({ holderExtensions: [CERT_POLICIES, subjectDirectoryAttributes({ subjectKind: 0x09 })] }));
    assert.equal(!r.ok && r.problem, "not_citizen_primary");
  });
  test("cardHolderRank mobile or secondary", async () => {
    for (const rank of ["mobile", "secondary"]) {
      const r = await select(await cert({ holderExtensions: [CERT_POLICIES, subjectDirectoryAttributes({ extra: [cardHolderRank(rank)] })] }));
      assert.equal(!r.ok && r.problem, "not_citizen_primary");
    }
  });
  test("a card key of 4096 bits", async () => {
    const big = await makeKey(4096);
    const r = await select(await certificate(buildTbs({ spki: big.spki }), keys.G3));
    assert.equal(!r.ok && r.problem, "unsupported_format");
  });
  test("an issuer name of 128 bytes or more", async () => {
    const r = await select(await cert({ issuer: name("Test CA", [100]) }));
    assert.equal(!r.ok && r.problem, "unsupported_format");
  });
  test("a subject of 128 to 255 bytes passes", async () => {
    assert.equal((await select(await cert({ subject: name("長名字", [60, 60]) }))).ok, true);
  });
  test("signed by a key that is neither issuer", async () => {
    const other = await makeKey(2048);
    const r = await select(await cert({}, other));
    assert.equal(!r.ok && r.problem, "unknown_issuer");
  });
  test("keyUsage not in third place", async () => {
    const r = await select(await cert({ leadingExtensions: [AUTHORITY_KEY_ID, KEY_USAGE_SIGNING, SUBJECT_KEY_ID] }));
    assert.equal(!r.ok && r.problem, "unsupported_format");
  });
  test("bytes after the certificate", async () => {
    const r = await select(concatBytes(await cert(), Uint8Array.of(0)));
    assert.equal(!r.ok && r.problem, "unsupported_format");
  });
  test("walk: every read stays inside the TBS", () => {
    const tbs = buildTbs({ spki: card.spki });
    for (const cut of [10, 100, 400, tbs.length - 300]) {
      const t = tbs.slice(0, cut);
      t[2] = (cut - 4) >> 8;
      t[3] = (cut - 4) & 0xff;
      assert.notEqual(walkTbs(t).failure, null);
    }
  });
});
