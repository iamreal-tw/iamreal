// The platform table of each proof log (spec/scope.md, "Platforms"): which
// platforms the proof log accepts and the `username` format of each. The record
// rules take a table (record-rules.ts); the server and a recomputation from
// the first record give them the table of their proof log, from here. The
// device does not: it uses the table the server sends (`config`,
// docs/api/card-proof.md), read into the same rows.
//
// The Go implementation has the same tables (verifier/scope.go, Platforms);
// the tests of both read them against spec/vectors/scope.json.
import { byBytes } from "./bytes.ts";
import type { ProofLog } from "./scope.ts";
import { type UsernameFormat, parseUsernameFormat } from "./username-format.ts";

/** A row of a platform table. */
export interface PlatformRow {
  /** The platform ID written in records and in the declaration code. */
  readonly platform: string;
  /** For screens; the rules do not read it. */
  readonly displayName: string;
  /** The `username` format of the platform, `[…]{m,n}`, as the table writes it and as read from it. */
  readonly format: UsernameFormat;
}

function row(platform: string, displayName: string, format: string): PlatformRow {
  const read = parseUsernameFormat(format);
  if (read === null) throw new Error(`platform table: the format of ${platform} is not in the one form`);
  return Object.freeze({ platform, displayName, format: read });
}

const byId = (a: PlatformRow, b: PlatformRow): number => byBytes(a.platform, b.platform);

/** The rows under "Production log". IDs starting with `test-` are never added here. */
const PRODUCTION: readonly PlatformRow[] = Object.freeze([row("threads", "Threads", "[a-z0-9._]{1,30}")]);
/** The rows under "Test logs only": a test log accepts the production rows and these. */
const TEST_ONLY: readonly PlatformRow[] = Object.freeze([row("test-example", "Example (no real service)", "[a-z0-9-]{1,20}")]);

const TABLES: Readonly<Record<ProofLog, readonly PlatformRow[]>> = Object.freeze({
  production: Object.freeze([...PRODUCTION].sort(byId)),
  test: Object.freeze([...PRODUCTION, ...TEST_ONLY].sort(byId)),
});

/**
 * The platforms `proofLog` accepts, in ascending order of ID by byte value:
 * the order of a record's account list.
 */
export function platformsOf(proofLog: ProofLog): readonly PlatformRow[] {
  return TABLES[proofLog];
}
