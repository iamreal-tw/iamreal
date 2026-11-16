// The specification's algorithms against spec/vectors/ (the same files the Go
// tests read).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesOfHex, hexOf, limbs, sha256Hex } from "../src/bytes.ts";
import { TAG, children, content, expectTlv } from "../src/der.ts";
import { CIRCUIT_OF_BITS, MOICA_ISSUERS, checkIssuerTable } from "../src/issuers.ts";
import { decodeBase32Strict, encodeBase32 } from "../src/spec/base32.ts";
import { currentTime, parseChallenge } from "../src/spec/challenge.ts";
import { type Day, formatDay, parseDay, taiwanDay } from "../src/spec/date.ts";
import { declarationCode, declarationPreimage } from "../src/spec/declaration-code.ts";
import { fieldBytes, pack31 } from "../src/spec/field.ts";
import { type CardState, declareOutcome, nextSwitchDay, switchesLeft, withdrawOutcome } from "../src/spec/roster-rules.ts";
import { lookupScope, normalizeUsername, scopeFor } from "../src/spec/scope.ts";
import { parseScopedId, scopedIdText, shortId } from "../src/spec/scoped-id.ts";
import { repoFile, vectors } from "./vectors.ts";

describe("challenge.json", () => {
  const v = vectors("challenge.json");
  for (const c of v.valid) {
    test(`valid ${c.challenge}`, () => {
      const day = parseChallenge(c.challenge);
      assert.notEqual(day, null);
      assert.equal(formatDay(day!), c.date);
      assert.equal(currentTime(day!), BigInt(c.current_time));
      assert.equal(hexOf(fieldBytes(currentTime(day!))), c.current_time_public_input);
      assert.equal(hexOf(decodeBase32Strict(c.challenge.slice(11), 16)!), c.random_bytes);
      assert.equal(encodeBase32(bytesOfHex(c.random_bytes)), c.challenge.slice(11));
    });
  }
  for (const c of v.invalid) {
    test(`invalid (${c.reason}) ${JSON.stringify(c.challenge)}`, () => assert.equal(parseChallenge(c.challenge), null));
  }
  test("not a string", () => {
    for (const x of [null, 1, {}, ["2026-11-16.000G40R40M30E209185GR38E1W"]]) assert.equal(parseChallenge(x), null);
  });
});

describe("Taiwan date from the clock", () => {
  test("UTC+8 regardless of the device's time zone", () => {
    assert.equal(formatDay(taiwanDay(Date.UTC(2026, 10, 15, 15, 59, 59))), "2026-11-15");
    assert.equal(formatDay(taiwanDay(Date.UTC(2026, 10, 15, 16, 0, 0))), "2026-11-16");
  });
  test("parseDay", () => {
    assert.equal(parseDay("2028-02-29") !== null, true);
    assert.equal(parseDay("2026-02-29"), null);
    assert.equal(parseDay("2026-11-16\n"), null);
  });
});

describe("scope.json", () => {
  const v = vectors("scope.json");
  for (const s of v.scopes) {
    test(`${s.roster} ${s.scope_string}`, () => {
      const row = lookupScope(s.roster, s.scope_string);
      assert.equal(row !== null, s.accepted);
      if (s.accepted) assert.equal("0x" + pack31(new TextEncoder().encode(s.scope_string)).toString(16).padStart(64, "0"), s.scope_packed);
    });
  }
  for (const u of v.usernames) {
    test(`username ${JSON.stringify(u.username)} in ${u.scope_string}`, () => {
      const row = lookupScope("production", u.scope_string) ?? lookupScope("test", u.scope_string);
      assert.equal(row!.validUsername(u.username), u.valid);
    });
  }
  test("the platform table", () => {
    assert.equal(scopeFor("test", "threads").scopeString, "iamreal-test:threads:0_________");
    assert.equal(scopeFor("production", "threads").scopeString, "iamreal:threads:0______________");
  });
  test("normalizeUsername lowercases ASCII only", () => {
    assert.equal(normalizeUsername("@Alice"), "alice");
    assert.equal(normalizeUsername("Kelvin"), "Kelvin"); // KELVIN SIGN stays, and fails the format
    assert.equal(scopeFor("test", "threads").validUsername(normalizeUsername("Kelvin")), false);
  });
});

describe("declaration-code.json", () => {
  for (const c of vectors("declaration-code.json").cases) {
    test(`${c.action} ${c.username} ${c.challenge}`, async () => {
      assert.equal(await sha256Hex(declarationPreimage(c.action, c.scope_string, c.username, c.challenge)), c.preimage_sha256);
      const code = await declarationCode(c.action, c.scope_string, c.username, c.challenge);
      assert.equal(new TextDecoder().decode(code), c.declaration_code);
      assert.equal("0x" + pack31(code).toString(16).padStart(64, "0"), c.declaration_code_packed);
    });
  }
});

describe("scoped-id.json", () => {
  const v = vectors("scoped-id.json");
  for (const e of v.encoding) {
    test(`text form: ${e.label}`, () => {
      const x = BigInt(e.field_element);
      assert.equal(scopedIdText(x), e.scoped_id);
      assert.equal(shortId(e.scoped_id), e.short_id);
      assert.equal(parseScopedId(e.scoped_id), x);
    });
  }
  for (const e of v.invalid) {
    test(`rejects ${JSON.stringify(e.scoped_id)} (${e.reason})`, () => assert.equal(parseScopedId(e.scoped_id), null));
  }
});

describe("issuers.json and the certificates in crl/", () => {
  const v = vectors("issuers.json");
  test("the table's shape", () => checkIssuerTable(MOICA_ISSUERS));
  for (const i of v.issuers) {
    test(`${i.issuer}`, async () => {
      const key = MOICA_ISSUERS.find((k) => k.name === i.issuer)!;
      assert.equal(key.modulus, BigInt(i.modulus));
      assert.equal(key.bits, i.modulus_bits);
      const k = CIRCUIT_OF_BITS[key.bits].limbs;
      assert.equal(k, i.limbs);
      assert.deepEqual(limbs(key.modulus, 120, k).map((x) => "0x" + x.toString(16)), i.issuer_modulus_limbs.map((x: string) => "0x" + BigInt(x).toString(16)));
      // The certificate file in crl/ is the one the table names, and holds this modulus.
      const der = repoFile(`crl/${i.issuer === "G2" ? "MOICA2.cer" : "MOICA-G3.cer"}`);
      assert.equal(await sha256Hex(der), i.certificate_sha256);
      const cert = expectTlv(der, 0, TAG.SEQUENCE, der.length, "cert");
      const tbs = children(der, cert)[0]!;
      // version, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
      const spki = children(der, tbs)[6]!;
      const bits = children(der, spki)[1]!;
      const rsa = expectTlv(der, bits.contentStart + 1, TAG.SEQUENCE, bits.end, "RSAPublicKey");
      const n = children(der, rsa)[0]!;
      let modulus = 0n;
      for (const b of content(der, n)) modulus = (modulus << 8n) | BigInt(b);
      assert.equal(modulus, key.modulus);
    });
  }
});

describe("roster-rules.json: what a card proof would be, from the card's state", () => {
  for (const c of vectors("roster-rules.json").cases) {
    test(c.name, () => {
      const states = new Map<string, CardState>();
      c.events.forEach((e: Record<string, any>, i: number) => {
        const r = c.results[i];
        const key = `${e.scope_string} ${e.scoped_id}`;
        const s = states.get(key) ?? { current: null, lastDeclared: null, lastCardProof: null, switchDates: [] };
        const d = parseDay(e.date)! as Day;
        // Outcomes the event rules decide; the other checks (proof, challenge, root, date) are not the device's.
        if (r.valid || r.reason === "switch_limit" || r.reason === "not_current") {
          const o = e.action === "declare" ? declareOutcome(s, e.username, d) : withdrawOutcome(s, e.username);
          if (r.valid) assert.deepEqual(o, { kind: r.kind }, `event ${e.seq}`);
          else assert.deepEqual(o, { kind: "blocked", reason: r.reason }, `event ${e.seq}`);
        }
        if (r.valid) {
          if (r.kind === "first" || r.kind === "switch") s.lastDeclared = e.username;
          if (r.kind === "switch") s.switchDates.push(d);
          s.current = r.kind === "withdraw" ? null : e.username;
          s.lastCardProof = s.lastCardProof === null ? d : Math.max(s.lastCardProof, d);
        }
        states.set(key, s);
      });
    });
  }
  test("switches left and the next date a switch is allowed", () => {
    const d = (s: string) => parseDay(s)!;
    const s: CardState = { current: "bob", lastDeclared: "bob", lastCardProof: d("2026-11-04"), switchDates: [d("2026-03-02")] };
    assert.equal(switchesLeft(s, d("2026-11-16")), 1);
    assert.equal(formatDay(nextSwitchDay(s, d("2026-11-16"))), "2026-11-16");
    s.switchDates.push(d("2026-06-01"));
    assert.equal(switchesLeft(s, d("2026-11-16")), 0);
    assert.deepEqual(declareOutcome(s, "alice", d("2026-11-16")), { kind: "blocked", reason: "switch_limit" });
    assert.equal(formatDay(nextSwitchDay(s, d("2026-11-16"))), "2027-03-02");
    assert.deepEqual(declareOutcome(s, "alice", d("2027-03-02")), { kind: "switch" });
    assert.deepEqual(declareOutcome(s, "alice", d("2027-03-01")), { kind: "blocked", reason: "switch_limit" });
  });
});
