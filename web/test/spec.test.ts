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
import { type CardState, EMPTY_SLOT, type SlotState, applyKind, dailyLimitReached, listOutcome, possibleCard, possibleSlot, slotOutcome } from "../src/spec/roster-rules.ts";
import { presentationOf } from "../src/platforms.ts";
import { TEST_EXAMPLE } from "../src/presentations/test-example.ts";
import { lookupScope, scopeOf } from "../src/spec/scope.ts";
import { parseScopedId, scopedIdText, shortId } from "../src/spec/scoped-id.ts";
import { isAnyUsername, isPlatformId, parseUsernameFormat } from "../src/spec/username-format.ts";
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

/**
 * The platform tables of spec/scope.md, read from the Markdown: the rows of
 * "Production roster" and "Test rosters only" under "## Platforms". The
 * device gets its table from the server (`config`); here the specification's
 * own table stands in for it, so that the device's reading of the formats
 * is checked against the vectors.
 */
function specPlatformTables(): Record<"production" | "test", { platform: string; displayName: string; format: string }[]> {
  const md = new TextDecoder().decode(repoFile("spec/scope.md"));
  const section = md.slice(md.indexOf("## Platforms"), md.indexOf("### Adding a platform"));
  // The first table after `heading`: its rows after the header and the separator.
  const tableAfter = (heading: string) => {
    const lines = section.slice(section.indexOf(heading) + heading.length).split("\n");
    const start = lines.findIndex((l) => l.startsWith("|"));
    const end = lines.findIndex((l, i) => i > start && !l.startsWith("|"));
    return lines
      .slice(start + 2, end)
      .map((l) => l.split("|").map((c) => c.trim()))
      .map((c) => ({ platform: c[1]!.replace(/`/g, ""), displayName: c[2]!, format: c[3]!.replace(/`/g, "") }));
  };
  const production = tableAfter("**Production roster**");
  const testOnly = tableAfter("**Test rosters only**");
  return { production, test: [...production, ...testOnly].sort((a, b) => (a.platform < b.platform ? -1 : 1)) };
}

describe("scope.json", () => {
  const v = vectors("scope.json");
  for (const s of v.scopes) {
    test(`${s.roster} ${s.scope_string}`, () => {
      assert.equal(lookupScope(s.roster, s.scope_string), s.accepted);
      if (s.accepted) {
        assert.equal(scopeOf(s.roster), s.scope_string);
        assert.equal("0x" + pack31(new TextEncoder().encode(s.scope_string)).toString(16).padStart(64, "0"), s.scope_packed);
      }
    });
  }
  const tables = specPlatformTables();
  test("the platform tables of spec/scope.md, as read here, are the ones the vectors accept", () => {
    assert.deepEqual(tables.production.map((r) => r.platform), ["threads"]);
    assert.deepEqual(tables.test.map((r) => r.platform), ["test-example", "threads"]);
    for (const p of v.platforms) {
      const row = tables[p.roster as "production" | "test"].find((r) => r.platform === p.platform);
      assert.equal(row !== undefined, p.accepted, `${p.roster} ${p.platform}`);
      if (p.accepted) assert.equal(row!.displayName, p.display_name);
    }
  });
  for (const p of v.platforms) {
    // The device cannot know a roster's table but from the server; what it checks of any ID is the syntax.
    if (p.accepted) test(`platform ID ${p.platform}`, () => assert.equal(isPlatformId(p.platform), true));
  }
  for (const u of v.usernames) {
    test(`username ${JSON.stringify(u.username)} on ${u.platform}`, () => {
      const row = tables.test.find((r) => r.platform === u.platform)!;
      const format = parseUsernameFormat(row.format);
      assert.notEqual(format, null, row.format);
      assert.equal(format!.accepts(u.username), u.valid);
    });
  }
  test("the one form of a format, read without a regular expression engine", () => {
    for (const ok of ["[a-z0-9._]{1,30}", "[a-z0-9-]{1,20}", "[-a]{1,1}", "[a-c-]{2,9}", "[A-Za-z0-9_]{1,15}"]) assert.notEqual(parseUsernameFormat(ok), null, ok);
    for (const bad of [
      "[a-z]+",
      "[a-z]{1,}",
      "[a-z]{0,5}",
      "[a-z]{5,1}",
      "[a-z]{01,5}",
      "[a-z]{1,5}x",
      "x[a-z]{1,5}",
      "[]{1,5}",
      "[^a]{1,5}",
      "[a-z]{1,5}\n",
      "[a\\]{1,5}",
      '[a"]{1,5}',
      "[!-~]{1,5}",
      "[ a]{1,5}",
      "[z-a]{1,5}",
      "[a-zé]{1,5}",
      "[[a]{1,5}",
      "(a){1,5}",
      "[a-z]{1,1000000000}",
      null,
      5,
    ]) {
      assert.equal(parseUsernameFormat(bad), null, JSON.stringify(bad));
    }
    const f = parseUsernameFormat("[a-z0-9._]{1,30}")!;
    // As a whole value: a trailing line feed is not accepted (spec/scope.md).
    assert.equal(f.accepts("alice\n"), false);
    assert.equal(f.accepts("a".repeat(30)), true);
    assert.equal(f.accepts("a".repeat(31)), false);
    assert.equal(f.accepts(""), false);
    assert.equal(f.accepts("Alice"), false);
    // A `-` last in the class stands for itself.
    assert.equal(parseUsernameFormat("[a-z0-9-]{1,20}")!.accepts("a-b"), true);
    assert.equal(parseUsernameFormat("[a-z0-9-]{1,20}")!.accepts("a.b"), false);
  });
  test("the checks every account on a platform the device does not know must pass", () => {
    for (const ok of ["a", "alice-b", "A b~", "x".repeat(200)]) assert.equal(isAnyUsername(ok), true, ok);
    for (const bad of ["", 'a"b', "a\\b", "a\nb", "é", "\u0000", null, 1]) assert.equal(isAnyUsername(bad), false, JSON.stringify(bad));
    for (const ok of ["threads", "test-example", "a", "x".repeat(21), "0-9"]) assert.equal(isPlatformId(ok), true, ok);
    for (const bad of ["", "Threads", "threads_", "a:b", "x".repeat(22), "a b", null]) assert.equal(isPlatformId(bad), false, JSON.stringify(bad));
  });
  test("Threads' normalize lowercases ASCII only", () => {
    const normalize = presentationOf("threads")!.normalize;
    const format = parseUsernameFormat(tables.production[0]!.format)!;
    assert.equal(normalize("@Alice"), "alice");
    assert.equal(normalize("Kelvin"), "Kelvin"); // KELVIN SIGN stays, and fails the format
    assert.equal(format.accepts(normalize("Kelvin")), false);
    // test-example (test builds only): the name as typed, no prefix.
    assert.equal(TEST_EXAMPLE.normalize("@A-b"), "@A-b");
    assert.equal(TEST_EXAMPLE.prefix, "");
  });
});

describe("declaration-code.json", () => {
  for (const c of vectors("declaration-code.json").cases) {
    test(c.label, async () => {
      const pre = declarationPreimage(c.scope_string, c.accounts, c.challenge);
      assert.equal(new TextDecoder().decode(pre), c.preimage);
      assert.equal(await sha256Hex(pre), c.preimage_sha256);
      const code = await declarationCode(c.scope_string, c.accounts, c.challenge);
      assert.equal(new TextDecoder().decode(code), c.declaration_code);
      assert.equal("0x" + pack31(code).toString(16).padStart(64, "0"), c.declaration_code_packed);
    });
  }
  test("a list out of order, or a platform ID with ':', is not computed", () => {
    const ch = "2026-11-16.000G40R40M30E209185GR38E1W";
    assert.throws(() => declarationPreimage(scopeOf("test"), [{ platform: "threads", username: "a" }, { platform: "test-example", username: "a" }], ch));
    assert.throws(() => declarationPreimage(scopeOf("test"), [{ platform: "threads", username: "a" }, { platform: "threads", username: "b" }], ch));
    assert.throws(() => declarationPreimage(scopeOf("test"), [{ platform: "a:b", username: "a" }], ch));
  });
});

describe("scoped-id.json", () => {
  const v = vectors("scoped-id.json");
  for (const e of v.encoding) {
    test(`text form: ${e.label}`, () => {
      const x = BigInt(e.field_element);
      assert.equal(scopedIdText(x), e.scoped_id);
      assert.equal(shortId(e.scoped_id), e.short_id);
      assert.equal(e.short_id.length, 10);
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

describe("roster-rules.json: what a card proof would do, from the card's state", () => {
  const TABLES = { production: ["threads"], test: ["test-example", "threads"] } as const;
  for (const c of vectors("roster-rules.json").cases) {
    test(c.name, () => {
      const platforms: readonly string[] = TABLES[c.roster as "production" | "test"];
      const cards = new Map<string, CardState>();
      const newCard = (): CardState => ({ lastCardProof: null, proofsOnLastDate: 0, slots: new Map(platforms.map((p) => [p, { ...EMPTY_SLOT }])) });
      c.events.forEach((e: Record<string, any>, i: number) => {
        const r = c.results[i];
        const key = `${e.scope_string} ${e.scoped_id}`;
        const s = cards.get(key) ?? newCard();
        const d = parseDay(e.date)! as Day;
        const list = new Map<string, string>(e.accounts.map((a: { platform: string; username: string }) => [a.platform, a.username]));
        const o = listOutcome(s.slots, list, d);
        // Outcomes the event rules decide; the other checks (proof, challenge, root, date) are not the device's.
        if (r.valid) assert.deepEqual(o, { valid: true, kinds: r.kinds }, `event ${e.seq}`);
        else if (r.reason === "switch_limit" || r.reason === "empty") assert.equal(!o.valid && o.reason, r.reason, `event ${e.seq}`);
        else if (r.reason === "daily_limit") assert.equal(o.valid, true, `event ${e.seq}: the event rules accept it`);
        // The device knows the count of one date only, the last card
        // proof's: there it agrees with the rules. It never blocks a valid record.
        if (r.valid) assert.equal(dailyLimitReached(s, d), false, `event ${e.seq}`);
        if (r.reason === "daily_limit" && d === s.lastCardProof) assert.equal(dailyLimitReached(s, d), true, `event ${e.seq}`);
        if (r.valid && o.valid) {
          for (const k of o.kinds) s.slots.set(k.platform, applyKind(s.slots.get(k.platform)!, k.kind, list.get(k.platform) ?? null, d));
          if (s.lastCardProof === null || d > s.lastCardProof) [s.lastCardProof, s.proofsOnLastDate] = [d, 1];
          else if (d === s.lastCardProof) s.proofsOnLastDate++;
        }
        // Every state the rules produce is one the device reads.
        const today = Math.max(d, s.lastCardProof ?? d);
        assert.ok(possibleCard(s.lastCardProof, s.proofsOnLastDate, today), `event ${e.seq}: the card's items`);
        for (const [p, slot] of s.slots) assert.ok(possibleSlot(slot, s.lastCardProof), `event ${e.seq}: the slot ${p}`);
        cards.set(key, s);
      });
      // The final state, as the vector has it.
      for (const scope of c.state) {
        for (const card of scope.cards) {
          const s = cards.get(`${scope.scope_string} ${card.scoped_id}`)!;
          assert.equal(formatDay(s.lastCardProof!), card.last_card_proof, card.scoped_id);
          assert.equal(s.proofsOnLastDate, card.proofs_on_last_date, card.scoped_id);
          const accounts = [...s.slots].flatMap(([platform, slot]) => (slot.current === null ? [] : [{ platform, username: slot.current }]));
          assert.deepEqual(accounts, card.accounts, card.scoped_id);
          const slots = Object.fromEntries(
            [...s.slots].map(([p, slot]) => [p, { current: slot.current, last_declared: slot.lastDeclared, switch_count: slot.switchCount, correction_date: slot.correctionDate === null ? null : formatDay(slot.correctionDate) }]),
          );
          assert.deepEqual(slots, card.slots, card.scoped_id);
        }
      }
    });
  }
  test("the event rules on one slot: first, refresh, correction, switch, blocked; withdraw", () => {
    const d = (s: string) => parseDay(s)!;
    const today = d("2026-11-16");
    const slot = (o: Partial<SlotState>): SlotState => ({ current: "alice", lastDeclared: "alice", switchCount: 1, correctionDate: d("2026-03-02"), ...o });
    assert.deepEqual(slotOutcome(EMPTY_SLOT, "alice", today), { kind: "first" });
    assert.deepEqual(slotOutcome(EMPTY_SLOT, null, today), { kind: "none" });
    assert.deepEqual(slotOutcome(slot({}), "alice", today), { kind: "refresh" });
    assert.deepEqual(slotOutcome(slot({ current: null }), "alice", today), { kind: "refresh" });
    assert.deepEqual(slotOutcome(slot({}), "bob", today), { kind: "switch" });
    assert.deepEqual(slotOutcome(slot({ correctionDate: today }), "bob", today), { kind: "correction" });
    assert.deepEqual(slotOutcome(slot({ switchCount: 5 }), "bob", today), { kind: "blocked" });
    // After the fifth, a correction on its date is still a correction.
    assert.deepEqual(slotOutcome(slot({ switchCount: 5, correctionDate: today }), "bob", today), { kind: "correction" });
    assert.deepEqual(slotOutcome(slot({}), null, today), { kind: "withdraw" });
    assert.deepEqual(slotOutcome(slot({ current: null }), null, today), { kind: "none" });
  });
  test("3 records today: nothing more today; tomorrow again", () => {
    const d = (s: string) => parseDay(s)!;
    const s = { lastCardProof: d("2026-11-16"), proofsOnLastDate: 3 };
    assert.equal(dailyLimitReached(s, d("2026-11-16")), true);
    assert.equal(dailyLimitReached(s, d("2026-11-17")), false);
    assert.equal(dailyLimitReached({ ...s, proofsOnLastDate: 2 }, d("2026-11-16")), false);
    // The last card proof dated after today (around midnight, or ahead): the count of today is not known here.
    assert.equal(dailyLimitReached(s, d("2026-11-15")), false);
    assert.equal(dailyLimitReached({ lastCardProof: null, proofsOnLastDate: 0 }, d("2026-11-16")), false);
  });
  test("states the rules cannot produce", () => {
    const d = (s: string) => parseDay(s)!;
    const today = d("2026-11-16");
    const lcp = d("2026-11-04");
    const ok: SlotState = { current: "bob", lastDeclared: "bob", switchCount: 1, correctionDate: d("2026-03-02") };
    assert.equal(possibleSlot(ok, lcp), true);
    assert.equal(possibleSlot(EMPTY_SLOT, null), true);
    assert.equal(possibleSlot({ ...ok, current: null }, lcp), true);
    for (const [label, s, l] of [
      ["current is not last_declared", { ...ok, current: "alice" }, lcp],
      ["last_declared without correction_date", { ...ok, correctionDate: null }, lcp],
      ["correction_date without last_declared", { ...EMPTY_SLOT, correctionDate: lcp }, lcp],
      ["switches without an account ever", { ...EMPTY_SLOT, switchCount: 1 }, lcp],
      ["6 switches", { ...ok, switchCount: 6 }, lcp],
      ["-1 switches", { ...ok, switchCount: -1 }, lcp],
      ["1.5 switches", { ...ok, switchCount: 1.5 }, lcp],
      ["an account without a last card proof", ok, null],
      ["correction_date after the last card proof", { ...ok, correctionDate: d("2026-11-05") }, lcp],
    ] as const) {
      assert.equal(possibleSlot(s as SlotState, l), false, label);
    }
    for (const n of [1, 2, 3]) assert.equal(possibleCard(lcp, n, today), true, String(n));
    for (const n of [0, 4, -1, 1.5, NaN, Infinity]) assert.equal(possibleCard(lcp, n, today), false, String(n));
    assert.equal(possibleCard(null, 0, today), true);
    for (const n of [1, 3, -1, 0.5]) assert.equal(possibleCard(null, n, today), false, String(n));
    assert.equal(possibleCard(d("2026-11-19"), 1, today), true);
    assert.equal(possibleCard(d("2026-11-20"), 1, today), false);
  });
});
