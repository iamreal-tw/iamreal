// The record rules with their state kept in memory: the way to compute the
// state of every card from the first record of a proof log. It keeps no record. Everything the rules decide is applyRecord
// (record-rules.ts); this file only keeps what that function asks its caller
// to keep between records: each card's state, the proof log's latest valid
// date, the challenges used.
import { byBytes } from "./bytes.ts";
import { parseChallenge } from "./challenge.ts";
import type { Day } from "./date.ts";
import type { PlatformRow } from "./platforms.ts";
import { type Account, type CardState, type RecordOutcome, applyRecord, newCard } from "./record-rules.ts";

/** A well-formed record, with the two answers the rules take from outside the proof log. */
export interface MemoryRulesRecord {
  scopeString: string;
  scopedId: string;
  /** In its one spelling (spec/challenge.md); its date is the record's date. */
  challenge: string;
  accounts: readonly Account[];
  /** Check 1: whether the record verifies. */
  verifies: boolean;
  /** Check 3: the CRL dates of the usable CRLs of the record's issuer whose tree has its root. */
  crlDates: readonly Day[];
}

/** A card of the output (spec/record-rules.md, "Output"). */
export interface OutputCard {
  scopedId: string;
  lastCardProof: Day;
  /** Its current list, in ascending order of platform. */
  accounts: Account[];
}

/** An account of the output, with the cards whose current account on the platform it is. */
export interface OutputAccount extends Account {
  cards: { scopedId: string; lastCardProof: Day }[];
}

export interface OutputScope {
  scopeString: string;
  cards: OutputCard[];
  accounts: OutputAccount[];
}

export class MemoryRules {
  private readonly platforms: readonly PlatformRow[];
  /** Scope string, then scoped ID. */
  private readonly cards = new Map<string, Map<string, CardState>>();
  private readonly used = new Set<string>();
  private latest: Day | null = null;
  private applied = 0;

  /** `platforms`: the proof log's platform table (spec/scope.md; platformsOf of platforms.ts). */
  constructor(platforms: readonly PlatformRow[]) {
    this.platforms = [...platforms].sort((a, b) => byBytes(a.platform, b.platform));
  }

  /**
   * Applies `r` as the next record. A valid record changes the state of its
   * card; an invalid one changes nothing but marks its challenge as used.
   * Throws, and changes nothing (not the count, not the challenges used),
   * for what is not a well-formed record of the proof log: a challenge not in
   * its one spelling, a list naming a platform outside the table or one
   * platform twice, not in ascending order of platform, or with a username
   * outside the format of its platform.
   */
  apply(r: MemoryRulesRecord): RecordOutcome {
    const date = parseChallenge(r.challenge);
    if (date === null) throw new Error("record rules: the challenge is not in its one spelling");
    const outcome = applyRecord({
      platforms: this.platforms,
      record: { accounts: r.accounts, date, verifies: r.verifies },
      card: this.card(r.scopeString, r.scopedId),
      latestValidDate: this.latest,
      challengeUsed: this.used.has(r.challenge),
      crlDates: r.crlDates,
    });
    if (outcome.result.valid) {
      let scope = this.cards.get(r.scopeString);
      if (!scope) this.cards.set(r.scopeString, (scope = new Map()));
      scope.set(r.scopedId, outcome.card);
    }
    this.latest = outcome.latestValidDate;
    this.used.add(r.challenge);
    this.applied++;
    return outcome;
  }

  /** The state of a card; of a card without a valid record, the empty state. */
  card(scopeString: string, scopedId: string): CardState {
    return this.cards.get(scopeString)?.get(scopedId) ?? newCard(this.platforms);
  }

  /** The number of records applied. */
  get count(): number {
    return this.applied;
  }

  /** The latest date among the valid records applied; null without one. */
  get latestValidDate(): Day | null {
    return this.latest;
  }

  /**
   * The output of the rules for the records applied so far, per scope
   * (spec/record-rules.md, "Output"): every sort by byte value; cards
   * without a valid record, accounts without a card and scopes without a
   * card are not listed.
   */
  output(): OutputScope[] {
    const out: OutputScope[] = [];
    for (const scopeString of [...this.cards.keys()].sort(byBytes)) {
      const scope = this.cards.get(scopeString)!;
      const cards: OutputCard[] = [];
      const accounts: OutputAccount[] = [];
      for (const scopedId of [...scope.keys()].sort(byBytes)) {
        const state = scope.get(scopedId)!;
        const lastCardProof = state.lastCardProof!;
        const list: Account[] = [];
        for (const { platform } of this.platforms) {
          const username = state.slots.get(platform)?.current ?? null;
          if (username === null) continue;
          list.push({ platform, username });
          let account = accounts.find((a) => a.platform === platform && a.username === username);
          if (!account) accounts.push((account = { platform, username, cards: [] }));
          account.cards.push({ scopedId, lastCardProof });
        }
        cards.push({ scopedId, lastCardProof, accounts: list });
      }
      accounts.sort((a, b) => byBytes(a.platform, b.platform) || byBytes(a.username, b.username));
      out.push({ scopeString, cards, accounts });
    }
    return out;
  }
}
