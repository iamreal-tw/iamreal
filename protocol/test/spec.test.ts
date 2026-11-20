// The specification's algorithms against spec/vectors/ (the same files the Go
// tests read).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytesOfHex, hexOf, sha256Hex } from "../src/bytes.ts";
import { decodeBase32Strict, encodeBase32 } from "../src/base32.ts";
import { currentTime, parseChallenge } from "../src/challenge.ts";
import { type Day, formatDay, parseDay, taiwanDay } from "../src/date.ts";
import { declarationCode, declarationPreimage } from "../src/declaration-code.ts";
import { fieldBytes, pack31 } from "../src/field.ts";
import { readMinApp } from "../src/min-app.ts";
import { platformsOf } from "../src/platforms.ts";
import { lookupScope, scopeOf } from "../src/scope.ts";
import { parseScopedId, readShortIdInUrl, scopedIdText, shortId } from "../src/scoped-id.ts";
import { isAnyUsername, isPlatformId, parseUsernameFormat } from "../src/username-format.ts";
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

describe("min-app.json", () => {
  for (const c of vectors("min-app.json").cases) {
    test(`${c.platform} ${c.app_build}: ${c.name}`, () => {
      const verdict = readMinApp(c.config, c.platform, c.app_build, c.now * 1000);
      if (c.result === "unreadable") assert.equal(verdict, null);
      else if (c.result === "ok_until") assert.deepEqual(verdict?.kind === "ok_until" ? { ...verdict, from: formatDay(verdict.from) } : verdict, { kind: "ok_until", from: c.from });
      else assert.deepEqual(verdict, { kind: c.result });
    });
  }
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
  test("the platform table of each roster in protocol/ is the one of the vectors and of spec/scope.md", () => {
    for (const roster of ["production", "test"] as const) {
      const rows = platformsOf(roster).map((r) => ({ platform: r.platform, displayName: r.displayName, format: r.format.text }));
      assert.deepEqual(rows, tables[roster], roster);
      const accepted = v.platforms
        .filter((p: Record<string, unknown>) => p.roster === roster && p.accepted)
        .map((p: Record<string, string>) => ({ platform: p.platform, displayName: p.display_name, format: p.username_format }));
      assert.deepEqual(rows, accepted, roster);
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
  for (const e of v.short_id_in_urls) {
    test(`a short ID in a URL: ${JSON.stringify(e.typed)} ${e.reads_as === null ? `does not read (${e.reason})` : `reads as ${e.reads_as}`}`, () => assert.equal(readShortIdInUrl(e.typed), e.reads_as));
  }
});

