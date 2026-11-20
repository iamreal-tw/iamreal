// The platform tables (spec/scope.md, "Platforms"): which platforms a roster
// accepts, each with its display name and its `username` format exactly as
// the specification writes it. The server answers `config` with its roster's
// table (docs/api/card-proof.md) and checks a submitted list against it. The
// device does not import this file: it takes the table from the server and
// has its own definitions of the platforms it offers.
import { byBytes } from "./bytes.ts";
import type { Roster } from "./scope.ts";

/** One row of a platform table. */
export interface Platform {
  /** The platform ID, as records and the declaration code write it. */
  readonly platform: string;
  /** For screens; the rules do not read it. */
  readonly displayName: string;
  /** One character class and one length range, `[…]{m,n}` (username-format.ts reads it). */
  readonly usernameFormat: string;
}

const PRODUCTION: readonly Platform[] = [{ platform: "threads", displayName: "Threads", usernameFormat: "[a-z0-9._]{1,30}" }];

/** A test roster accepts these besides the production rows. IDs starting with `test-` are never production rows. */
const TEST_ONLY: readonly Platform[] = [{ platform: "test-example", displayName: "Example (no real service)", usernameFormat: "[a-z0-9-]{1,20}" }];

const byId = (a: Platform, b: Platform): number => byBytes(a.platform, b.platform);

const TABLES: Readonly<Record<Roster, readonly Platform[]>> = Object.freeze({
  production: Object.freeze([...PRODUCTION].sort(byId).map((p) => Object.freeze(p))),
  test: Object.freeze([...PRODUCTION, ...TEST_ONLY].sort(byId).map((p) => Object.freeze(p))),
});

/** The platforms `roster` accepts, in ascending order of platform ID by byte value: the order of a record's list. */
export function platformsOf(roster: Roster): readonly Platform[] {
  return TABLES[roster];
}

/** The platform IDs of `roster`, in the same order: the table the roster rules take. */
export function platformIdsOf(roster: Roster): readonly string[] {
  return TABLES[roster].map((p) => p.platform);
}
