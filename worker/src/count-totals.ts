// The counts' totals (ADR-0032, ADR-0039; README.md, "計數的加總"): the
// hourly schedule reads the files of counts (counts.ts), which the bucket's
// lifecycle rule deletes after 31 days, and writes totals under
// `count-totals/`, where no rule deletes. A total holds no IP address and no
// ID: no visit ID, card proof device ID or attempt ID, no request ID.
//
// - A day (UTC, as the files of counts are named) is totalled once, at the
//   first run 2 hours or more after it ends, and its file is never written
//   again. Attempts are joined by their IDs while the day is read, and the
//   IDs are then dropped: an attempt is the day's whose first count is in
//   it, and the hour before and the hour after the day are read so that one
//   across midnight is joined.
// - A month (UTC) has one file, which each totalled day adds its numbers to,
//   once: the file says which days it has. When the month's last day is
//   added, the month is over, and the devices that sent several cards are
//   counted.
// - The devices that sent several cards need card proof device IDs across
//   the days of a month, and the connection log they are read from is
//   deleted after 31 days. So each totalled day writes, under `count-events/`
//   where the lifecycle rule deletes after 31 days, which cards each device
//   sent that day (`devices.json`, from the connection log's successful
//   submissions), and this program deletes each such file once 31 days have
//   passed since its day began (the maintainer, 2026-11-27, #435). The month
//   is counted from the files still there: in a month of 31 days, its first
//   day's file is gone by then, and the number is a little low.
// - A source domain and the values of the monthly cells (a version, a card
//   reader's name) are strings anyone can make up: each day keeps the 100
//   that came most often of each, and the rest together as `other`.
import { BROWSERS, CARD_PROOF_ACTIONS, CLIENTS, type Client, type Count, DURATIONS, OSES, PAGES, REASONS, STEPS, TIMED_STEPS, VISITOR_ACTIONS } from "iamreal-protocol/counts.ts";
import { COUNT_EVENTS_PREFIX } from "./counts.ts";

export const COUNT_TOTALS_PREFIX = "count-totals/";
/** Under this prefix the days' totals, whose keys begin with their dates: the first is the earliest. */
export const DAY_TOTALS_PREFIX = `${COUNT_TOTALS_PREFIX}day/`;
const MONTH_TOTALS_PREFIX = `${COUNT_TOTALS_PREFIX}month/`;

export const dayTotalsKey = (day: string): string => `${DAY_TOTALS_PREFIX}${day}.json`;
export const monthTotalsKey = (month: string): string => `${MONTH_TOTALS_PREFIX}${month}.json`;
export const devicesKey = (day: string): string => `${COUNT_EVENTS_PREFIX}${day}/devices.json`;

/** Where the date of the earliest day's totals is published, in the bucket of the public data. */
export const COUNT_TOTALS_OLDEST_KEY = "count-totals/oldest.json";

/** How many source domains, and how many values of a monthly cell, a day keeps by themselves; the rest are `other`. */
export const KEPT_PER_DAY = 100;
/** How many different domains, or values of a monthly cell, a day keeps track of while it is read; one more goes to `other` at once. What bounds the memory a day's reading takes. */
const TRACKED = 20_000;
/** An attempt with no count for longer than this, in minutes, is over: a count with its ID after that begins another. */
const ATTEMPT_IDLE_MINUTES = 60;
/** How long after a day ends it is totalled: its last minute's file is written by then. */
const DAY_WAIT_MS = 2 * 3_600_000;
/** A day is totalled only while the files of the hour before it are surely still there (31 days, less a margin). */
const DAY_WINDOW_DAYS = 30;
/** At most this many days are totalled in one run: a run that catches up reads no more files than this many days have. */
const DAYS_PER_RUN = 2;
/** A file of the devices of a day is deleted this many days after the day began (the maintainer, 2026-11-27). */
const DEVICES_DAYS = 31;
/** How many short IDs, or seqs, are asked of the proof log at once. */
const ASK_AT_ONCE = 1_000;
/** How many files are read from the bucket at once. */
const READ_AT_ONCE = 16;

const DAY_MS = 24 * 3_600_000;

/** What the totals ask the proof log, and nothing else. */
export interface TotalsProofLog {
  /** Of these short IDs, those of a card of the open scope whose first valid record is dated `through` (Taiwan's date) or before. */
  knownShortIds(shortIds: readonly string[], through: string): Promise<readonly string[]>;
  /** How many short IDs have such a card. */
  shortIdsThrough(through: string): Promise<number>;
  /** The scoped ID of the record of each seq; none for a seq the proof log does not have. */
  scopedIdsOf(seqs: readonly number[]): Promise<readonly { readonly seq: number; readonly scopedId: string }[]>;
}

/** A UTC date, `YYYY-MM-DD`, of a time. */
const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const startOf = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number): string => dateOf(startOf(day) + n * DAY_MS);
/** A minute's name (`2026-11-26T14:05Z`) as minutes since the epoch. */
const minuteNumber = (minute: string): number => Date.parse(`${minute.slice(0, 16)}:00Z`) / 60_000;

const MINUTE_FILE = /^count-events\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)\.json$/;

// ---------------------------------------------------------------------------
// The tables of a day: every code the table has for a client, with 0 for one that did not come.

type Table = Readonly<Record<string, readonly Client[]>>;
type Numbers = Record<string, number>;

const zeros = (codes: readonly string[]): Numbers => Object.fromEntries(codes.map((c) => [c, 0]));
const codesFor = (table: Table, client: Client): string[] => Object.keys(table).filter((c) => table[c]!.includes(client));
const byClient = (table: Table): Record<Client, Numbers> => Object.fromEntries(CLIENTS.map((client) => [client, zeros(codesFor(table, client))])) as Record<Client, Numbers>;
const ACTIONS: Table = { ...VISITOR_ACTIONS, ...CARD_PROOF_ACTIONS };
const APPS: readonly Client[] = ["android", "ios"];

/** Adds one to a code of a table, if the table has it. */
function bump(numbers: Numbers | undefined, code: string | undefined, n = 1): void {
  if (numbers !== undefined && code !== undefined && code in numbers) numbers[code]! += n;
}

/** Keys in byte order: a file written twice from the same counts is the same. */
function sorted<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// What is kept of strings anyone can make up: at most TRACKED while a day is read, the KEPT_PER_DAY most frequent at the end.

/** The KEPT_PER_DAY keys of most weight, the lighter one before by key; the rest are left out. */
function heaviest<T>(map: ReadonlyMap<string, T>, weight: (t: T) => number): Set<string> {
  const keys = [...map.keys()].sort((a, b) => weight(map.get(b)!) - weight(map.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
  return new Set(keys.slice(0, KEPT_PER_DAY));
}

// ---------------------------------------------------------------------------
// The monthly cells of the card proofs.

/** A cell: the attempts whose counts carried this value, how many of them were done, and the reasons they stopped and were tried again for. */
export interface Cell {
  attempts: number;
  done: number;
  stops: Numbers;
  retries: Numbers;
}
const newCell = (): Cell => ({ attempts: 0, done: 0, stops: {}, retries: {} });
function addCell(to: Cell, from: Cell): void {
  to.attempts += from.attempts;
  to.done += from.done;
  for (const [r, n] of Object.entries(from.stops)) to.stops[r] = (to.stops[r] ?? 0) + n;
  for (const [r, n] of Object.entries(from.retries)) to.retries[r] = (to.retries[r] ?? 0) + n;
}
const cellOut = (c: Cell): Cell => ({ attempts: c.attempts, done: c.done, stops: sorted(new Map(Object.entries(c.stops))), retries: sorted(new Map(Object.entries(c.retries))) });

/** The values a card proof is counted by each month, by client: a web browser and an operating system with their versions, a card reader; an app's system and app versions. */
const DIMENSIONS: Readonly<Record<Client, readonly string[]>> = { web: ["browser", "os", "reader"], android: ["os_version", "app_version"], ios: ["os_version", "app_version"] };

/** The value of a dimension a count carries, or undefined. */
function valueOf(count: Count, dimension: string): string | undefined {
  if (dimension === "browser" || dimension === "os") {
    const kind = count[dimension];
    if (kind === undefined) return undefined;
    const version = count[`${dimension}_version`];
    return version === undefined ? kind : `${kind} ${version}`;
  }
  return count[dimension];
}

/** The cells of one dimension: by value, the attempts that carried none, and the values that were not kept by themselves. */
export interface Cells {
  values: Record<string, Cell>;
  none: Cell;
  other: Cell;
}
const newCells = (): Cells => ({ values: {}, none: newCell(), other: newCell() });

/** A dimension's cells while a day is read. */
class DayCells {
  readonly values = new Map<string, Cell>();
  readonly none = newCell();
  readonly other = newCell();
  cellOf(value: string | undefined): Cell {
    if (value === undefined) return this.none;
    let cell = this.values.get(value);
    if (cell === undefined) {
      if (this.values.size >= TRACKED) return this.other;
      this.values.set(value, (cell = newCell()));
    }
    return cell;
  }
  /** The KEPT_PER_DAY values of most attempts by themselves, the rest in `other`. */
  done(): Cells {
    const kept = heaviest(this.values, (c) => c.attempts);
    const other = newCell();
    addCell(other, this.other);
    const values = new Map<string, Cell>();
    for (const [v, c] of this.values) {
      if (kept.has(v)) values.set(v, cellOut(c));
      else addCell(other, c);
    }
    return { values: sorted(values), none: cellOut(this.none), other: cellOut(other) };
  }
}

// ---------------------------------------------------------------------------
// A day.

/** What a card's page got in a day, or a month. */
export interface CardNumbers {
  opened: number;
  download_app: number;
  start_card_proof: number;
}

/** A source domain's counts, by kind of page. */
interface SourcesOfPage {
  none: number;
  domains: Record<string, number>;
  other: number;
}

/** A day's totals, as its file holds them. */
export interface DayTotals {
  readonly date: string;
  /** How many files of minutes the day had, and how many counts they said were not kept. */
  readonly minutes: number;
  readonly dropped: number;
  readonly clients: Numbers;
  readonly pages: Numbers;
  readonly sources: Record<string, SourcesOfPage>;
  /** A visitor's pages opened, by browser and by operating system. */
  readonly browsers: Numbers;
  readonly oses: Numbers;
  readonly actions: Record<Client, Numbers>;
  /** The taps that broke off, by which tap. */
  readonly taps_dropped: Record<string, Numbers>;
  readonly steps: Record<Client, Numbers>;
  readonly stops: Record<Client, Numbers>;
  readonly retries: Record<Client, Numbers>;
  readonly durations: Record<Client, Record<string, Numbers>>;
  /** The attempts that began in the day, joined: how many, how many reached each step, how many were done. */
  readonly attempts: Record<Client, { started: number; done: number; reached: Numbers }>;
  /** How many proof pages there were, and how many were opened 0 times, 1 to 9, 10 to 99, 100 or more. */
  readonly card_pages: { cards: number; opened: { "0": number; "1_9": number; "10_99": number; "100_or_more": number } };
}

/** What a day adds to its month, besides being there. */
interface DayForMonth {
  readonly cards: ReadonlyMap<string, CardNumbers>;
  readonly cardProofs: Record<string, Record<string, Cells>>;
}

/** An attempt while a day is read. */
interface Attempt {
  readonly client: Client;
  /** Whether its first count is in the day. */
  readonly ofDay: boolean;
  last: number;
  readonly steps: Set<string>;
  readonly values: Record<string, string>;
  readonly stops: string[];
  readonly retries: string[];
}

/** Reads a day's counts in the order they came, and the hour on each side of it, and totals them. */
class DayReader {
  readonly #day: string;
  readonly #first: number;
  readonly #end: number;
  readonly #proofLog: TotalsProofLog;
  readonly #through: string;

  #minutes = 0;
  #dropped = 0;
  readonly #clients = zeros(CLIENTS);
  readonly #pages = zeros(PAGES);
  readonly #browsers = zeros(BROWSERS);
  readonly #oses = zeros(OSES);
  readonly #actions = byClient(ACTIONS);
  readonly #taps = Object.fromEntries(APPS.map((c) => [c, zeros(["1", "2", "3"])])) as Record<string, Numbers>;
  readonly #steps = byClient(STEPS);
  readonly #stops = byClient(REASONS);
  readonly #retries = byClient(REASONS);
  readonly #durations = Object.fromEntries(CLIENTS.map((c) => [c, Object.fromEntries(codesFor(TIMED_STEPS, c).map((s) => [s, zeros(DURATIONS)]))])) as Record<Client, Record<string, Numbers>>;
  readonly #started = zeros(CLIENTS);
  readonly #reached = byClient(STEPS);

  /** Domains by kind of page; the pages' counts with no source, and those of domains not kept. */
  readonly #domains = new Map<string, Numbers>();
  readonly #noSource = zeros(PAGES);
  readonly #otherSource = zeros(PAGES);

  readonly #attempts = new Map<string, Attempt>();
  readonly #cells = Object.fromEntries(CLIENTS.map((c) => [c, Object.fromEntries(DIMENSIONS[c].map((d) => [d, new DayCells()]))])) as Record<Client, Record<string, DayCells>>;

  /** The counts of short IDs not yet asked of the proof log, and those of short IDs it has. */
  #asking = new Map<string, CardNumbers>();
  readonly #cards = new Map<string, CardNumbers>();

  constructor(day: string, proofLog: TotalsProofLog) {
    this.#day = day;
    this.#first = startOf(day) / 60_000;
    this.#end = this.#first + 24 * 60;
    this.#proofLog = proofLog;
    // A UTC day ends at 08:00 of the next day in Taiwan: a card whose first record is dated then could be opened in it.
    this.#through = addDays(day, 1);
  }

  get day(): string {
    return this.#day;
  }

  /** The minutes to read: the day's, and an hour on each side. */
  get from(): number {
    return this.#first - 60;
  }
  get until(): number {
    return this.#end + 60;
  }

  async add(minute: number, counts: readonly Count[], dropped: number): Promise<void> {
    const inDay = minute >= this.#first && minute < this.#end;
    if (inDay) {
      this.#minutes++;
      this.#dropped += dropped;
    }
    for (const count of counts) {
      if (inDay) await this.#addToDay(count);
      if (count["attempt_id"] !== undefined) this.#addToAttempt(minute, inDay, count);
    }
    // Attempts with no count for an hour are over.
    for (const [id, a] of this.#attempts) {
      if (minute - a.last > ATTEMPT_IDLE_MINUTES) {
        this.#attempts.delete(id);
        this.#close(a);
      }
    }
  }

  async #addToDay(c: Count): Promise<void> {
    const client = c["client"] as Client;
    bump(this.#clients, client);
    switch (c["event"]) {
      case "page": {
        const page = c["page"]!;
        bump(this.#pages, page);
        bump(this.#browsers, c["browser"]);
        bump(this.#oses, c["os"]);
        const domain = c["source"];
        if (domain === undefined) bump(this.#noSource, page);
        else {
          let pages = this.#domains.get(domain);
          if (pages === undefined && this.#domains.size < TRACKED) this.#domains.set(domain, (pages = zeros(PAGES)));
          bump(pages ?? this.#otherSource, page);
        }
        if (page === "card") await this.#addToCard(c["short_id"], "opened");
        break;
      }
      case "action": {
        const action = c["action"]!;
        bump(this.#actions[client], action);
        if (action === "tap_dropped") bump(this.#taps[client], c["tap"]);
        if (action === "start_card_proof") await this.#addToCard(c["short_id"], "start_card_proof");
        if (action === "download_app_android" || action === "download_app_ios") await this.#addToCard(c["short_id"], "download_app");
        break;
      }
      case "step":
        bump(this.#steps[client], c["step"]);
        break;
      case "stop":
        bump(this.#stops[client], c["reason"]);
        break;
      case "retry":
        bump(this.#retries[client], c["reason"]);
        break;
      case "duration":
        bump(this.#durations[client]?.[c["step"]!], c["took"]);
        break;
    }
  }

  async #addToCard(shortId: string | undefined, what: keyof CardNumbers): Promise<void> {
    if (shortId === undefined) return;
    const known = this.#cards.get(shortId);
    if (known !== undefined) {
      known[what]++;
      return;
    }
    let asking = this.#asking.get(shortId);
    if (asking === undefined) this.#asking.set(shortId, (asking = { opened: 0, download_app: 0, start_card_proof: 0 }));
    asking[what]++;
    if (this.#asking.size >= ASK_AT_ONCE) await this.#ask();
  }

  /** Asks the proof log which of the short IDs waiting it has: theirs are kept, the others' dropped. */
  async #ask(): Promise<void> {
    if (this.#asking.size === 0) return;
    const asking = this.#asking;
    this.#asking = new Map();
    for (const id of await this.#proofLog.knownShortIds([...asking.keys()], this.#through)) {
      const n = asking.get(id);
      if (n !== undefined) this.#cards.set(id, n);
    }
  }

  #addToAttempt(minute: number, inDay: boolean, c: Count): void {
    const id = c["attempt_id"]!;
    let a = this.#attempts.get(id);
    if (a !== undefined && minute - a.last > ATTEMPT_IDLE_MINUTES) {
      this.#attempts.delete(id);
      this.#close(a);
      a = undefined;
    }
    if (a === undefined) {
      a = { client: c["client"] as Client, ofDay: inDay, last: minute, steps: new Set(), values: {}, stops: [], retries: [] };
      this.#attempts.set(id, a);
    }
    a.last = minute;
    if (c["event"] === "step") a.steps.add(c["step"]!);
    if (c["event"] === "stop") a.stops.push(c["reason"]!);
    if (c["event"] === "retry") a.retries.push(c["reason"]!);
    for (const d of DIMENSIONS[a.client] ?? []) {
      if (a.values[d] !== undefined) continue;
      const v = valueOf(c, d);
      if (v !== undefined) a.values[d] = v;
    }
  }

  /** An attempt that is over: counted if it began in the day. */
  #close(a: Attempt): void {
    if (!a.ofDay || !(a.client in this.#started)) return;
    this.#started[a.client]!++;
    for (const s of a.steps) bump(this.#reached[a.client], s);
    for (const d of DIMENSIONS[a.client]) {
      const cell = this.#cells[a.client][d]!.cellOf(a.values[d]);
      cell.attempts++;
      if (a.steps.has("done")) cell.done++;
      for (const r of a.stops) cell.stops[r] = (cell.stops[r] ?? 0) + 1;
      for (const r of a.retries) cell.retries[r] = (cell.retries[r] ?? 0) + 1;
    }
  }

  async done(): Promise<{ totals: DayTotals; forMonth: DayForMonth }> {
    for (const a of this.#attempts.values()) this.#close(a);
    this.#attempts.clear();
    await this.#ask();

    const kept = heaviest(this.#domains, (pages) => Object.values(pages).reduce((x, y) => x + y, 0));
    const sources: Record<string, SourcesOfPage> = {};
    for (const page of PAGES) {
      const domains = new Map<string, number>();
      let other = this.#otherSource[page]!;
      for (const [domain, pages] of this.#domains) {
        const n = pages[page]!;
        if (n === 0) continue;
        if (kept.has(domain)) domains.set(domain, n);
        else other += n;
      }
      sources[page] = { none: this.#noSource[page]!, domains: sorted(domains), other };
    }

    const cards = await this.#proofLog.shortIdsThrough(this.#through);
    const opened = { "0": 0, "1_9": 0, "10_99": 0, "100_or_more": 0 };
    for (const n of this.#cards.values()) {
      if (n.opened >= 100) opened["100_or_more"]++;
      else if (n.opened >= 10) opened["10_99"]++;
      else if (n.opened >= 1) opened["1_9"]++;
    }
    opened["0"] = Math.max(0, cards - opened["1_9"] - opened["10_99"] - opened["100_or_more"]);

    const attempts = Object.fromEntries(CLIENTS.map((c) => [c, { started: this.#started[c]!, done: this.#reached[c]["done"]!, reached: this.#reached[c] }])) as DayTotals["attempts"];
    const totals: DayTotals = {
      date: this.#day,
      minutes: this.#minutes,
      dropped: this.#dropped,
      clients: this.#clients,
      pages: this.#pages,
      sources,
      browsers: this.#browsers,
      oses: this.#oses,
      actions: this.#actions,
      taps_dropped: this.#taps,
      steps: this.#steps,
      stops: this.#stops,
      retries: this.#retries,
      durations: this.#durations,
      attempts,
      card_pages: { cards, opened },
    };
    const cardProofs = Object.fromEntries(CLIENTS.map((c) => [c, Object.fromEntries(DIMENSIONS[c].map((d) => [d, this.#cells[c][d]!.done()]))]));
    return { totals, forMonth: { cards: this.#cards, cardProofs } };
  }
}

// ---------------------------------------------------------------------------
// A month.

/** A month's totals, as its file holds them. */
export interface MonthTotals {
  readonly month: string;
  /** The days whose numbers are in it, in order. */
  days: string[];
  /** Each proof page's numbers, by short ID: only short IDs the proof log has. */
  cards: Record<string, CardNumbers>;
  /** The card proofs by client and by each value they are counted by. */
  card_proofs: Record<string, Record<string, Cells>>;
  /**
   * Once the month is over: how many devices sent 2 different cards in it,
   * and 3 or more, counted from the days whose file of devices was still
   * there (`days`).
   */
  devices: { days: string[]; cards_2: number; cards_3_or_more: number } | null;
}

const newMonth = (month: string): MonthTotals => ({
  month,
  days: [],
  cards: {},
  card_proofs: Object.fromEntries(CLIENTS.map((c) => [c, Object.fromEntries(DIMENSIONS[c].map((d) => [d, newCells()]))])),
  devices: null,
});

function addDayToMonth(month: MonthTotals, day: string, add: DayForMonth): void {
  month.days = [...month.days, day].sort();
  const cards = new Map(Object.entries(month.cards));
  for (const [id, n] of add.cards) {
    const was = cards.get(id) ?? { opened: 0, download_app: 0, start_card_proof: 0 };
    cards.set(id, { opened: was.opened + n.opened, download_app: was.download_app + n.download_app, start_card_proof: was.start_card_proof + n.start_card_proof });
  }
  month.cards = sorted(cards);
  for (const [client, dims] of Object.entries(add.cardProofs)) {
    for (const [d, cells] of Object.entries(dims)) {
      const to = (month.card_proofs[client] ??= {})[d] ?? newCells();
      const values = new Map(Object.entries(to.values));
      for (const [v, cell] of Object.entries(cells.values)) {
        const was = values.get(v) ?? newCell();
        addCell(was, cell);
        values.set(v, cellOut(was));
      }
      addCell(to.none, cells.none);
      addCell(to.other, cells.other);
      month.card_proofs[client]![d] = { values: sorted(values), none: cellOut(to.none), other: cellOut(to.other) };
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the bucket.

const write = (bucket: R2Bucket, key: string, value: unknown): Promise<unknown> => bucket.put(key, `${JSON.stringify(value)}\n`, { httpMetadata: { contentType: "application/json" } });

async function readJson(bucket: R2Bucket, key: string): Promise<unknown> {
  const object = await bucket.get(key);
  return object === null ? undefined : JSON.parse(await object.text());
}

/** Every key under a prefix, in order. */
async function keysUnder(bucket: R2Bucket, prefix: string, startAfter?: string): Promise<string[]> {
  const keys: string[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await bucket.list({ prefix, ...(startAfter !== undefined && { startAfter }), ...(cursor !== undefined && { cursor }) });
    keys.push(...page.objects.map((o) => o.key));
    if (!page.truncated) return keys;
    cursor = page.cursor;
  }
}

/** A minute's file as the counts' object writes it, or null for anything else: one line in the live log, with its key. */
function readMinuteFile(key: string, text: string): { counts: Count[]; dropped: number } | null {
  try {
    const v = JSON.parse(text) as { counts?: unknown; dropped?: unknown };
    if (Array.isArray(v.counts) && typeof v.dropped === "number") {
      const counts = v.counts.filter((c): c is Count => typeof c === "object" && c !== null && Object.values(c).every((x) => typeof x === "string"));
      if (counts.length === v.counts.length) return { counts, dropped: v.dropped };
    }
  } catch {
    // Said below.
  }
  console.error(JSON.stringify({ event: "count_totals_file_unreadable", key }));
  return null;
}

/** Reads the minutes `reader` wants, in order, and gives them to it. */
async function readMinutes(bucket: R2Bucket, reader: DayReader): Promise<void> {
  const files: { key: string; minute: number }[] = [];
  for (const day of [addDays(reader.day, -1), reader.day, addDays(reader.day, 1)]) {
    for (const key of await keysUnder(bucket, `${COUNT_EVENTS_PREFIX}${day}/`)) {
      const m = MINUTE_FILE.exec(key);
      if (m === null || m[1] !== m[2]!.slice(0, 10)) continue;
      const minute = minuteNumber(m[2]!);
      if (minute >= reader.from && minute < reader.until) files.push({ key, minute });
    }
  }
  files.sort((a, b) => a.minute - b.minute);
  for (let i = 0; i < files.length; i += READ_AT_ONCE) {
    const batch = files.slice(i, i + READ_AT_ONCE);
    const texts = await Promise.all(batch.map(async (f) => (await bucket.get(f.key))?.text() ?? null));
    for (const [j, f] of batch.entries()) {
      const text = texts[j];
      if (text === null || text === undefined) continue;
      const file = readMinuteFile(f.key, text);
      if (file !== null) await reader.add(f.minute, file.counts, file.dropped);
    }
  }
}

/** Which cards each device sent in a day: the connection log's successful submissions that carried a card proof device ID. */
async function devicesOf(bucket: R2Bucket, day: string, proofLog: TotalsProofLog): Promise<Record<string, string[]>> {
  const keys = await keysUnder(bucket, `connection/${day}/`);
  const sent: { device: string; seq: number }[] = [];
  for (let i = 0; i < keys.length; i += READ_AT_ONCE) {
    const entries = await Promise.all(keys.slice(i, i + READ_AT_ONCE).map((k) => readJson(bucket, k).catch(() => undefined)));
    for (const e of entries) {
      const { device_id, seq } = (typeof e === "object" && e !== null ? e : {}) as { device_id?: unknown; seq?: unknown };
      if (typeof device_id === "string" && typeof seq === "number") sent.push({ device: device_id, seq });
    }
  }
  const scoped = new Map<number, string>();
  const seqs = [...new Set(sent.map((s) => s.seq))];
  for (let i = 0; i < seqs.length; i += ASK_AT_ONCE) for (const { seq, scopedId } of await proofLog.scopedIdsOf(seqs.slice(i, i + ASK_AT_ONCE))) scoped.set(seq, scopedId);
  const devices = new Map<string, Set<string>>();
  for (const s of sent) {
    const card = scoped.get(s.seq);
    if (card === undefined) continue;
    let cards = devices.get(s.device);
    if (cards === undefined) devices.set(s.device, (cards = new Set()));
    cards.add(card);
  }
  return sorted(new Map([...devices].map(([d, cards]) => [d, [...cards].sort()])));
}

/** Once a month is over: the devices that sent 2 different cards in it, and 3 or more, from the days' files that are still there. */
async function devicesOfMonth(bucket: R2Bucket, month: string): Promise<NonNullable<MonthTotals["devices"]>> {
  const cards = new Map<string, Set<string>>();
  const days: string[] = [];
  for (let day = `${month}-01`; day.startsWith(month); day = addDays(day, 1)) {
    const file = (await readJson(bucket, devicesKey(day))) as { devices?: Record<string, string[]> } | undefined;
    if (file?.devices === undefined) continue;
    days.push(day);
    for (const [device, ids] of Object.entries(file.devices)) {
      let set = cards.get(device);
      if (set === undefined) cards.set(device, (set = new Set()));
      for (const id of ids) set.add(id);
    }
  }
  let two = 0;
  let more = 0;
  for (const set of cards.values()) {
    if (set.size === 2) two++;
    else if (set.size >= 3) more++;
  }
  return { days, cards_2: two, cards_3_or_more: more };
}

/**
 * Totals one day: the day's file of devices if it has none, its numbers
 * added to its month's file (and the month closed if it was its last day),
 * then the day's own file. In that order, so that a run that broke off
 * leaves nothing that the next would add twice: the day is totalled again,
 * the same, and the month already has it.
 */
async function totalDay(bucket: R2Bucket, day: string, proofLog: TotalsProofLog): Promise<void> {
  const reader = new DayReader(day, proofLog);
  await readMinutes(bucket, reader);
  const { totals, forMonth } = await reader.done();

  if ((await bucket.head(devicesKey(day))) === null) await write(bucket, devicesKey(day), { date: day, devices: await devicesOf(bucket, day, proofLog) });

  const monthName = day.slice(0, 7);
  const month = ((await readJson(bucket, monthTotalsKey(monthName))) as MonthTotals | undefined) ?? newMonth(monthName);
  if (!month.days.includes(day)) {
    addDayToMonth(month, day, forMonth);
    if (addDays(day, 1).slice(0, 7) !== monthName) month.devices = await devicesOfMonth(bucket, monthName);
    await write(bucket, monthTotalsKey(monthName), month);
  }
  await write(bucket, dayTotalsKey(day), totals);
}

/**
 * One run of the totals, at `time`: deletes the files of devices whose 31
 * days are over, then totals the days that are due and not totalled yet,
 * the earliest first, at most DAYS_PER_RUN of them. A day is due 2 hours
 * after it ends, while the hour before it is surely still in the bucket,
 * once there are counts: it has a minute's file of counts, or an earlier
 * day has totals.
 */
export async function countTotals(bucket: R2Bucket, proofLog: TotalsProofLog, time: Date): Promise<void> {
  const nowMs = time.getTime();
  const today = dateOf(nowMs);

  // The days whose 31 days are over, back as far as a run that was missed for two weeks.
  const overdue: string[] = [];
  for (let day = addDays(today, -(DEVICES_DAYS + 14)); startOf(day) + DEVICES_DAYS * DAY_MS <= nowMs; day = addDays(day, 1)) overdue.push(devicesKey(day));
  if (overdue.length > 0) await bucket.delete(overdue);

  const earliest = addDays(today, -DAY_WINDOW_DAYS + 1);
  const totalled = new Set(await keysUnder(bucket, DAY_TOTALS_PREFIX, dayTotalsKey(addDays(earliest, -1))));
  const first = (await bucket.list({ prefix: DAY_TOTALS_PREFIX, limit: 1 })).objects[0]?.key;
  let done = 0;
  for (let day = earliest; startOf(day) + DAY_MS + DAY_WAIT_MS <= nowMs && done < DAYS_PER_RUN; day = addDays(day, 1)) {
    if (totalled.has(dayTotalsKey(day))) continue;
    const begun = (first !== undefined && first < dayTotalsKey(day)) || (await bucket.list({ prefix: `${COUNT_EVENTS_PREFIX}${day}/${day}T`, limit: 1 })).objects.length > 0;
    if (!begun) continue;
    await totalDay(bucket, day, proofLog);
    done++;
  }
}
