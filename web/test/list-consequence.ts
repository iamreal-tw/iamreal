// One case of spec/vectors/list-consequence.json, computed by web/'s code:
// the platform table of `config` and the answer of `card-state` read as
// src/api.ts reads them, then the cardholder's list through
// consequenceOfChoice (src/flow.ts). The generator (test/generate/) and the
// test (list-consequence.test.ts) both use it.
import { parseDay } from "iamreal-protocol/date.ts";
import type { Account } from "iamreal-protocol/roster-rules.ts";
import { type CardStateResponse, type Config, requestCardState, requestConfig } from "../src/api.ts";
import { type Choice, FlowStop, consequenceOfChoice, statusOf } from "../src/flow.ts";

/** A case's input: the two answers as the server sent them, today's date in Taiwan, the cardholder's list. */
export interface ListConsequenceCase {
  platforms: unknown;
  card_state: unknown;
  today: string;
  accounts: Account[];
}

export interface ResultRow {
  platform: string;
  known: boolean;
  kind: string;
  username: string;
  current: string | null;
  previous: string | null;
  switches_left: number | null;
}

/** The result of a case, in the vectors' spelling. */
export type ListConsequenceResult =
  | { unread: "platforms" | "card_state" }
  | { not_offered: true }
  | { valid: false; reason: string; platform?: string }
  | { valid: true; accounts: Account[]; rows: ResultRow[]; first_record: boolean };

/** Any scoped ID: the screen shows it, the consequence does not read it. */
const SCOPED_ID = "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880";

const answer = (body: unknown) => async (): Promise<Response> => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export async function listConsequenceResult(c: ListConsequenceCase): Promise<ListConsequenceResult> {
  const today = parseDay(c.today);
  if (today === null) throw new Error(`the case's date ${c.today}`);
  let config: Config;
  try {
    // config's other fields are not part of the case.
    config = await requestConfig(answer({ crl_max_age_days: 7, platforms: c.platforms }));
  } catch {
    return { unread: "platforms" };
  }
  let state: CardStateResponse;
  try {
    state = await requestCardState(answer(c.card_state), "iamreal:public:0_______________", SCOPED_ID, config.platforms, today);
  } catch {
    return { unread: "card_state" };
  }
  const status = statusOf(state, config.platforms, SCOPED_ID, today);
  // The screen offers every platform of the table with an entry in the state, empty unless the list names it.
  const entries: Record<string, string> = Object.fromEntries(status.slots.filter((s) => s.row !== null).map((s) => [s.platform, ""]));
  for (const a of c.accounts) entries[a.platform] = a.username;
  try {
    const r = consequenceOfChoice(status, state, entries as Choice, today);
    return {
      valid: true,
      accounts: r.accounts.map(({ platform, username }) => ({ platform, username })),
      rows: r.rows.map((row) => ({
        platform: row.platform,
        known: row.row !== null,
        kind: row.kind,
        username: row.username,
        current: row.current,
        previous: row.previous,
        switches_left: row.switchesLeftAfter,
      })),
      first_record: r.firstRecord,
    };
  } catch (e) {
    if (!(e instanceof FlowStop)) throw e;
    const stop = e.stop;
    if (stop.code === "state") return { not_offered: true };
    if (stop.code === "username") return { valid: false, reason: "username", platform: stop.platform };
    if (stop.code === "blocked") return stop.reason === "switch_limit" ? { valid: false, reason: stop.reason, platform: stop.platform! } : { valid: false, reason: stop.reason };
    throw e;
  }
}
