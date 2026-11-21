// One case of spec/vectors/card-status.json, computed by web/'s code: the
// platform table of `config` and the answer of `card-state` read as
// src/api.ts reads them, then the card's state as the screen of its
// accounts shows it (src/flow.ts, statusOf; the days since the last card
// proof as src/ui/messages.ts counts them). The generator (test/generate/)
// and the test (card-status.test.ts) both use it.
import { parseDay } from "iamreal-protocol/date.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { type CardStateResponse, type Config, requestCardState, requestConfig } from "../src/api.ts";
import { statusOf } from "../src/flow.ts";
import { daysBetween } from "../src/ui/messages.ts";

/** A case's input: the two answers as the server sent them, the platforms the device has its own definition of, today's date in Taiwan. */
export interface CardStatusCase {
  platforms: unknown;
  card_state: unknown;
  known_platforms: string[];
  today: string;
}

export type StatusRow =
  | { platform: string; known: true; current: string | null; last_declared: string | null; switch_count: number; switches_left: number; correction_today: boolean }
  | { platform: string; known: false; current: string };

/** The result of a case, in the vectors' spelling. */
export type CardStatusResult =
  | { unread: "platforms" | "card_state" }
  | { last_card_proof: string | null; days_since: number | null; daily_limit: boolean; known_platforms: string[]; rows: StatusRow[] };

/** Any scoped ID: the status does not read it. */
const SCOPED_ID = "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880";

const answer = (body: unknown) => async (): Promise<Response> => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export async function cardStatusResult(c: CardStatusCase): Promise<CardStatusResult> {
  const today = parseDay(c.today);
  if (today === null) throw new Error(`the case's date ${c.today}`);
  let config: Config;
  try {
    // config's other fields are not part of the case.
    config = await requestConfig(answer({ crl_max_age_days: 7, platforms: c.platforms }));
  } catch {
    return { unread: "platforms" };
  }
  const known = new Set(c.known_platforms);
  const table = config.platforms.filter((r) => known.has(r.platform));
  let state: CardStateResponse;
  try {
    state = await requestCardState(answer(c.card_state), scopeOf("production"), SCOPED_ID, table, today);
  } catch {
    return { unread: "card_state" };
  }
  const status = statusOf(state, table, SCOPED_ID, today);
  return {
    last_card_proof: status.lastCardProof,
    days_since: status.lastCardProof === null ? null : daysBetween(status.lastCardProof, status.today),
    daily_limit: status.dailyLimit,
    known_platforms: status.tablePlatforms,
    rows: status.slots.map((s) =>
      s.row === null
        ? { platform: s.platform, known: false as const, current: s.current! }
        : { platform: s.platform, known: true as const, current: s.current, last_declared: s.lastDeclared, switch_count: s.switchCount, switches_left: s.switchesLeft, correction_today: s.correctionToday },
    ),
  };
}
