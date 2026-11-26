// The entry point of the test build (test/build.ts): the Worker of
// src/index.ts, and in front of it the switches the tests need that the
// deployed Worker must not have. Never in the deployed build
// (test/bundle.test.ts).
//
// - The clock, and the environment's settings. The settings a test replaces
//   are kept here, in memory, and laid over the environment the Worker and
//   the object are given. wrangler.jsonc is not touched: the deployed
//   settings are the ones the deploy build reads.
// - Which proof verifier `records` asks. A test worker starts with the one
//   the deployed Worker has (src/in-worker.ts), and the tests about proofs
//   keep it. A proof takes a real card's keys and seconds to make, so the
//   tests about everything else (the challenge, the CRLs, the record rules,
//   the write) switch to a stand-in that judges a proof by its first byte
//   (and on one value of it moves the clock, as a verification that took time),
//   as the Go backend's tests do (e159ab9:server/harness_test.go, fakeProofs). The
//   stand-in is behind the same interface the deployed Worker names its
//   verifier by (src/index.ts, `API_PARTS`).
// - A door to the proof verifier itself, for inputs no record can carry
//   (public inputs that are not a record's), and one to what the proof log's
//   object knows of the CRL archive. Both call what the deployed Worker has;
//   nothing of them is replaced here.
// - Doors to the proof log's object, for what no request can do. The object of
//   the test build is the deployed one (src/proof-log.ts) with methods added:
//   run its alarm now and read when it is set for; give it a second piece
//   of timed work; choose the random bytes of the next challenge, so that a
//   test gets the challenge a proof was made for; change the versions its
//   tables say they were made by and computed by; write a row of the card
//   state table as it is given, for the states the rules cannot leave;
//   break its tables, or one card's row, or make every write to one of them fail, to see what
//   the API answers when the back end itself fails; drop the table of the
//   newest CRLs; and run the record rules on the object's stored state for
//   an event the API would never write (an invalid record of a proof log),
//   and read the latest valid date and the cards of each account as the
//   object reads and counts them;
//   read the rows it keeps of its records and of the proof log as a whole,
//   which no endpoint shows yet; read the plan SQLite makes for each
//   statement the pages' reads run; and wait before it hashes a record, so
//   that requests sent at once do cross where the deployed object lets
//   them (in the local workerd the hash alone does not let another in);
//   and make a write or a read of the data bucket go wrong, to see what
//   becomes of a full log file that could not be moved there.
import { byBytes, bytesOfHex } from "iamreal-protocol/bytes.ts";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { formatDay, parseDay } from "iamreal-protocol/date.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import type { ProofLogRecord } from "iamreal-protocol/record.ts";
import { type CardState, type RecordResult, RULES_VERSION, type SlotState, applyRecord } from "iamreal-protocol/record-rules.ts";
import { type ApiParts, api, isApiPath } from "../src/api.ts";
import { copyCards, dropCardsCopy, writeCard } from "../src/card-table.ts";
import { EngineError } from "../src/engine.ts";
import worker from "../src/index.ts";
import { proofVerifier } from "../src/in-worker.ts";
import type { FileBucket } from "../src/proof-log-files.ts";
import { ProofLog as DeployedProofLog, SCHEMA_VERSION, type TimedWork, proofLogOf } from "../src/proof-log.ts";
import { slotOfJson } from "../src/slot-json.ts";
import { VIEW_TABLE_KEYS, clearViews, viewOf, writeView } from "../src/views.ts";
import type { BucketFault, CardToWrite, KeptRecords, PagePlan, PagePlanQuestion, PagePlans, RuleEvent, RuleStateAnswer, StoredProofLog, StoredViews, TestSettings } from "./card-door.ts";
import { now, setTestClock } from "./target.ts";

let testSettings: TestSettings = {};

/** The environment with the settings the test replaced. */
const testEnv = (env: Env): Env => ({ ...env, ...testSettings });

/**
 * The stand-in verifier: it looks at nothing but the proof's first byte. 0
 * is accepted, 1 is rejected, and on 2 it cannot run, as the Worker's
 * verifier when Barretenberg does not start (src/engine.ts). 3 is accepted
 * after the test clock is moved one millisecond on: a verification that
 * took time, for the challenge that expires during it.
 */
const STAND_IN: ApiParts = {
  verifier: {
    async verify(_circuit, proof) {
      if (proof[0] === 2) throw new EngineError("the stand-in verifier does not start on this proof", true);
      if (proof[0] === 3) setTestClock(now().getTime() + 1);
      return proof[0] !== 1;
    },
  },
};

let standIn = false;

/** The requests that reached the Worker's code, the doors aside (`GET /__test/seen`). */
const seen: string[] = [];

/**
 * What a test can make every write to fail on: a table the object writes,
 * or only the mark that a record was written for a challenge (the column
 * `accepted`), which leaves counting a submission as it is.
 */
const FAILING_WRITES = {
  records: "ON records",
  cards: "ON cards",
  proof_log: "ON proof_log",
  challenges: "ON challenges",
  "challenges.accepted": "OF accepted ON challenges",
  view_cards: "ON view_cards",
  view_ordinals: "ON view_ordinals",
  view_slots: "ON view_slots",
  view_history: "ON view_history",
  view_state: "ON view_state",
} as const;
type FailingWrite = keyof typeof FAILING_WRITES;

export class ProofLog extends DeployedProofLog {
  /** The second piece of timed work: when it is next due, how long after each run it is due again, and when it ran. */
  #extraDue: number | null = null;
  #extraEvery = 0;
  readonly #extraRuns: number[] = [];
  /** The random bytes of the next challenge, if the test chose them. */
  #nextRandom: Uint8Array | null = null;
  /** How long the object waits before it hashes a record, in milliseconds, and how many records it has hashed. */
  #hashDelayMs = 0;
  #hashes = 0;
  /** How the object's writes or reads of one object of the data bucket go wrong, if the test chose so. */
  #bucketFault: BucketFault = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, testEnv(env));
  }

  protected override timedWork(): readonly TimedWork[] {
    const extra: TimedWork = {
      due: () => this.#extraDue,
      run: (time) => {
        this.#extraRuns.push(time);
        this.#extraDue = this.#extraDue! + this.#extraEvery;
      },
    };
    return [...super.timedWork(), extra];
  }

  protected override challengeRandom(): Uint8Array {
    const chosen = this.#nextRandom;
    this.#nextRandom = null;
    return chosen ?? super.challengeRandom();
  }

  protected override async hashOf(record: ProofLogRecord): Promise<string> {
    this.#hashes++;
    // A timer, unlike the hash, lets the requests that are waiting run.
    if (this.#hashDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#hashDelayMs));
    return super.hashOf(record);
  }

  /** The data bucket, with the fault the test chose (BucketFault) on the one object it chose it for. */
  protected override bucket(): FileBucket {
    const real = super.bucket();
    const fault = this.#bucketFault;
    if (fault === null) return real;
    const faulty = {
      put: async (key: string, sent: Uint8Array | ReadableStream<Uint8Array>, options: R2PutOptions): Promise<R2Object | null> => {
        if (key !== fault.key) return real.put(key, sent, options);
        if (fault.how === "put fails") throw new Error("the test makes this write fail");
        if (fault.how === "put breaks off") {
          if (sent instanceof ReadableStream) {
            const reader = sent.getReader();
            await reader.read();
            await reader.cancel();
          }
          throw new Error("the test makes this write break off");
        }
        if (fault.how === "put takes a while") {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return real.put(key, sent, options);
        }
        // The faults below change the bytes or the headers: a stream is read whole first (a test's files are small).
        const value = sent instanceof ReadableStream ? new Uint8Array(await new Response(sent).arrayBuffer()) : sent;
        if (fault.how === "put sends other bytes") return real.put(key, value.subarray(0, -1), options);
        // A bucket that stores other bytes than it was sent: the checksum the object gave is not passed on, or the simulated bucket would refuse them.
        if (fault.how === "put writes other bytes") return real.put(key, value.subarray(0, -1), { ...options, sha256: undefined } as R2PutOptions);
        const headers = options.httpMetadata as R2HTTPMetadata;
        const otherHeaders = fault.how === "put writes another Cache-Control" ? { cacheControl: "public, max-age=60" } : fault.how === "put writes another Content-Type" ? { contentType: "application/octet-stream" } : {};
        const written = await real.put(key, value, { ...options, httpMetadata: { ...headers, ...otherHeaders } });
        if (fault.how === "put loses its answer") throw new Error("the test loses the answer of this write");
        return written;
      },
      get: async (key: string): Promise<R2ObjectBody | null> => {
        if (key === fault.key && fault.how === "get fails") throw new Error("the test makes this read fail");
        return real.get(key);
      },
    };
    return faulty as unknown as FileBucket;
  }

  /** The names of the tables of the object's SQLite, in byte order. */
  testTables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name)
      .sort(byBytes);
  }

  /** From now on the object's use of the data bucket goes wrong as `fault` says, or, with null, not at all. Kept in memory. */
  testSetBucketFault(fault: BucketFault): void {
    this.#bucketFault = fault;
  }

  /** From now on the object waits this long before it hashes a record. */
  testSetHashDelay(ms: number): void {
    this.#hashDelayMs = ms;
  }

  /** How many times the object has hashed a record since it started. */
  testHashes(): number {
    return this.#hashes;
  }

  /** The next challenge has these 16 bytes in place of random ones. */
  testSetNextRandom(random: Uint8Array): void {
    this.#nextRandom = random;
  }

  /** Gives the object a second piece of timed work, due at `due` and then every `every` milliseconds. */
  async testSetExtraWork(due: number, every: number): Promise<void> {
    this.#extraDue = due;
    this.#extraEvery = every;
    await this.setAlarmForTimedWork();
  }

  /** The times, on the object's clock, at which the second piece of timed work ran. */
  testExtraWorkRuns(): number[] {
    return [...this.#extraRuns];
  }

  /** The handler of the alarm that is running or was last to run, however it was started. */
  #alarms: Promise<void> = Promise.resolve();

  /**
   * The alarm's handler, one run at a time. The deployed object's handler
   * never runs twice at once, and its timed work counts on that
   * (src/proof-log.ts, `#dailyPublication`); only this build has a second way
   * to start it (`testRunAlarm`), which could run it while the alarm
   * itself rings. So here every run, the alarm's own too, waits for the
   * one before it.
   */
  override alarm(): Promise<void> {
    const run = this.#alarms.then(() => super.alarm());
    this.#alarms = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs the alarm now, whatever time it is set for. As when it rings by
   * itself, the alarm that was set is spent first: the handler then finds
   * none set, and sets the next one.
   */
  async testRunAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.alarm();
  }

  /** The time the alarm is set for, in milliseconds since the epoch on the runtime's clock, or null. */
  testAlarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Writes a row of the card state table as it is given (src/card-table.ts): how a test stores a state the rules cannot have left. */
  testWriteCard(scopeString: string, scopedId: string, card: CardState, seq: number): void {
    writeCard(this.ctx.storage.sql, scopeString, scopedId, card, seq);
  }

  /** Writes rows of the card state table as they are given, in one transaction: how a measurement fills the table with many cards. */
  testWriteCards(cards: readonly { scopeString: string; scopedId: string; card: CardState; seq: number }[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const c of cards) writeCard(this.ctx.storage.sql, c.scopeString, c.scopedId, c.card, c.seq);
    });
  }

  /** Copies the card state table, as a publication does (src/card-table.ts, `copyCards`), or drops the copy: how a measurement times either alone. */
  testCardsCopy(what: "copy" | "drop"): void {
    if (what === "drop") dropCardsCopy(this.ctx.storage.sql);
    else copyCards(this.ctx.storage.sql);
  }

  /** Makes the stored version of the tables another one than the build's, or the build's. Takes effect when the object starts again. */
  testSetStoredSchemaVersion(to: "another" | "the build's"): void {
    this.ctx.storage.sql.exec("UPDATE proof_log SET schema_version = ? WHERE id = 1", to === "another" ? SCHEMA_VERSION + 1 : SCHEMA_VERSION);
  }

  /** Makes the version of the record rules the stored state says it was computed by another one than the build's, or the build's. Takes effect when the object starts again. */
  testSetStoredRulesVersion(to: "another" | "the build's"): void {
    this.ctx.storage.sql.exec("UPDATE proof_log SET rules_version = ? WHERE id = 1", to === "another" ? RULES_VERSION + 1 : RULES_VERSION);
  }

  /** Drops the table of the newest CRLs: the object is then as one made by a build that did not have it yet. */
  testDropNewestCrls(): void {
    this.ctx.storage.sql.exec("DROP TABLE newest_crls");
  }

  /**
   * Makes the stored slots of one card text that is not JSON, by putting
   * `not JSON` in front of them, so that reading the row fails; or, with
   * `mend`, takes that away again, which leaves the row as it was. Throws
   * if there is no such row.
   */
  testBreakCard(scopeString: string, scopedId: string, mend: boolean): void {
    const sql = this.ctx.storage.sql;
    const { rowsWritten } = mend
      ? sql.exec("UPDATE cards SET slots = substr(slots, 9) WHERE scope_string = ? AND scoped_id = ? AND slots LIKE 'not JSON%'", scopeString, scopedId)
      : sql.exec("UPDATE cards SET slots = 'not JSON' || slots WHERE scope_string = ? AND scoped_id = ? AND slots NOT LIKE 'not JSON%'", scopeString, scopedId);
    if (rowsWritten !== 1) throw new Error("no such row");
  }

  /** Begins the rebuild from the proof log named `token`, as the object does for an operator's (src/proof-log.ts, `beginRebuild`); whether one was begun. */
  testBeginRebuild(token: string): Promise<boolean> {
    return this.beginRebuild(token);
  }

  /** Drops the tables the API reads, so that the object's methods throw until it starts again. */
  testBreak(): void {
    this.ctx.storage.sql.exec("DROP TABLE challenges");
    this.ctx.storage.sql.exec("DROP TABLE cards");
  }

  /**
   * From now on every write to `what` fails, or, with null, none does: a
   * trigger in the object's own SQLite, so that the write fails where the
   * storage would fail it, in the middle of whatever was being written.
   */
  testFailWritesTo(what: FailingWrite | null): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DROP TRIGGER IF EXISTS test_fail_insert");
    sql.exec("DROP TRIGGER IF EXISTS test_fail_update");
    if (what === null) return;
    if (!Object.hasOwn(FAILING_WRITES, what)) throw new Error("not something the object writes");
    const fail = "BEGIN SELECT RAISE(ABORT, 'the test makes this write fail'); END";
    sql.exec(`CREATE TRIGGER test_fail_update BEFORE UPDATE ${FAILING_WRITES[what]} ${fail}`);
    if (what !== "challenges.accepted") sql.exec(`CREATE TRIGGER test_fail_insert BEFORE INSERT ${FAILING_WRITES[what]} ${fail}`);
  }

  /** Every row of the views (src/views.ts), table by table, each in the order of its primary key. */
  testViews(): StoredViews {
    const out: Record<string, Record<string, string | number | null>[]> = {};
    for (const [table, key] of Object.entries(VIEW_TABLE_KEYS)) out[table] = this.ctx.storage.sql.exec<Record<string, string | number | null>>(`SELECT * FROM ${table} ORDER BY ${key}`).toArray();
    return out;
  }

  /**
   * Clears the views, as on an object that has records from before it had
   * them. The object fills them from its records when it starts again.
   */
  testClearViews(): void {
    this.ctx.storage.transactionSync(() => clearViews(this.ctx.storage.sql));
  }

  /**
   * Empties `view_ordinals` and leaves the other views as they are: an
   * object whose views were filled before that table was one. It fills its
   * views again when it starts.
   */
  testForgetOrdinals(): void {
    this.ctx.storage.sql.exec("DELETE FROM view_ordinals");
  }

  /** How many records the object keeps, and the first and the last `seq` among them. */
  testKept(): KeptRecords {
    return this.ctx.storage.sql.exec<{ count: number; first: number | null; last: number | null }>("SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last FROM records").one();
  }

  /** Waits until the object has filled its views, or has given up (src/proof-log.ts, `viewsFilling`). */
  async testViewsFilled(): Promise<void> {
    await this.viewsFilling;
  }

  /** The rows of `records`, in the order of `seq`, and the count and the proof log fingerprint of the row of `proof_log`, as they are stored. */
  testStored(): StoredProofLog {
    const sql = this.ctx.storage.sql;
    return {
      records: sql.exec<{ seq: number; line: string; record_hash: string; fingerprint: string }>("SELECT seq, line, record_hash, fingerprint FROM records ORDER BY seq").toArray(),
      proofLog: sql.exec<{ count: number; fingerprint: string }>("SELECT count, fingerprint FROM proof_log WHERE id = 1").one(),
    };
  }

  /**
   * What the stored state says besides the cards' rows (RuleStateAnswer):
   * the latest valid date as `ruleState` reads it, and the cards of each
   * account as `accountCards` counts them. Which accounts there are is read
   * here from the rows of the card states; the count is the deployed
   * query's, which asks the views.
   */
  testRuleState(scopeString: string, scopedId: string): RuleStateAnswer {
    const { latestValidDate } = this.ruleState(scopeString, scopedId);
    const accounts: { platform: string; username: string; account_cards: number }[] = [];
    for (const platform of this.settings.platforms.map((p) => p.platform).sort(byBytes)) {
      const declared = this.ctx.storage.sql
        .exec<{ username: string }>("SELECT DISTINCT json_extract(slots, ?) AS username FROM cards WHERE scope_string = ? AND json_extract(slots, ?) IS NOT NULL", `$."${platform}".current`, scopeString, `$."${platform}".current`)
        .toArray()
        .map((r) => r.username)
        .sort(byBytes);
      for (const username of declared) accounts.push({ platform, username, account_cards: this.accountCards(scopeString, platform, username) });
    }
    return { latest_valid_date: latestValidDate === null ? null : formatDay(latestValidDate), accounts };
  }

  /**
   * Runs the record rules for one event of spec/vectors/record-rules.json on
   * the state the object stores, and keeps what a valid one leaves: the
   * same reading and the same writing of the state as for a submitted
   * record (src/proof-log.ts, `ruleState`, `keepRuleState`), and the same
   * change to the views (src/views.ts, `viewOf`, `writeView`), which is
   * where the deployed object counts the cards of an account. No record is
   * stored for an event, so the views' own count of records is put back to
   * the proof log's afterwards: the object would otherwise take the views for
   * stale when it next starts, and fill them from records that are not
   * there. The answers the
   * rules take from outside the proof log come with the event. Which
   * challenges were used is kept in a table of the test's own, since the
   * back end never writes an invalid record and so keeps no challenge of
   * one.
   */
  testApplyRuleEvent(e: RuleEvent): RecordResult {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS test_used_challenges (challenge TEXT PRIMARY KEY) WITHOUT ROWID");
    const date = parseChallenge(e.challenge);
    if (date === null) throw new Error("the event's challenge is not a challenge");
    const challengeUsed = sql.exec("SELECT 1 FROM test_used_challenges WHERE challenge = ?", e.challenge).toArray().length > 0;
    const { card, latestValidDate } = this.ruleState(e.scope_string, e.scoped_id);
    const outcome = applyRecord({
      platforms: this.settings.platforms,
      record: { accounts: e.accounts, date, verifies: e.verifies },
      card,
      latestValidDate,
      challengeUsed,
      crlDates: e.crl_dates.map((d) => parseDay(d)!),
    });
    this.ctx.storage.transactionSync(() => {
      if (outcome.result.valid) {
        this.keepRuleState(e.scope_string, e.scoped_id, outcome.card, e.seq, outcome.latestValidDate);
        const { count } = sql.exec<{ count: number }>("SELECT count FROM proof_log WHERE id = 1").one();
        sql.exec("UPDATE view_state SET seq = ? WHERE id = 1", e.seq - 1);
        writeView(sql, viewOf({ seq: e.seq, scopeString: e.scope_string, scopedId: e.scoped_id }, date, outcome.result.kinds, card, outcome.card));
        sql.exec("UPDATE view_state SET seq = ? WHERE id = 1", count);
      }
      sql.exec("INSERT OR IGNORE INTO test_used_challenges (challenge) VALUES (?)", e.challenge);
    });
    return outcome.result;
  }

  /**
   * The plan SQLite makes for every statement the pages' reads run
   * (src/proof-log.ts, `pageCounts`, `pageCards`, `pageAccount`, and
   * `pageLogPart` from the latest record and before a `seq`), and the count of
   * the cards of an account that a submission's answer reads
   * (`accountCards`). The reads are the deployed object's, called as the
   * pages and a submission call them; only the object's SQLite is put
   * behind one that asks `EXPLAIN QUERY PLAN` of each statement, with the
   * same values, before it runs it. The object's own SQLite is back in
   * place when this returns.
   */
  testPagePlans(q: PagePlanQuestion): PagePlans {
    const storage = this.ctx.storage;
    const sql = storage.sql;
    const plans: PagePlan[] = [];
    let read = "";
    const explaining = {
      exec: (statement: string, ...values: SqlStorageValue[]) => {
        plans.push({ read, statement, plan: sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement}`, ...values).toArray().map((row) => row.detail) });
        return sql.exec(statement, ...values);
      },
    };
    const reads: [string, () => unknown][] = [
      ["counts", () => this.pageCounts(q.platform)],
      ["cards", () => this.pageCards(q.short_id)],
      ["account", () => this.pageAccount(q.platform, q.username)],
      ["log", () => this.pageLogPart(q.platform, null, 50)],
      ["log before", () => this.pageLogPart(q.platform, q.before, 50)],
      ["account cards", () => this.accountCards(scopeOf(this.settings.kind), q.platform, q.username)],
    ];
    Object.defineProperty(storage, "sql", { value: explaining, configurable: true });
    try {
      for (const [name, run] of reads) {
        read = name;
        run();
      }
    } finally {
      delete (storage as { sql?: unknown }).sql;
    }
    if ((storage.sql as unknown) === explaining) throw new Error("the object's own SQLite is not back in place");
    return plans;
  }
}

/** The proof log's object (src/proof-log.ts, proofLogOf), as the class of the test build. */
const testProofLogOf = (env: Env): DurableObjectStub<ProofLog> => proofLogOf(env) as unknown as DurableObjectStub<ProofLog>;

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const done = (): Response => new Response(null, { status: 204 });

export default {
  ...worker,
  /**
   * - `PUT /__test/clock` with milliseconds since the epoch sets the clock.
   * - `PUT /__test/settings` with a TestSettings replaces settings of the
   *   environment from now on. An object that is running keeps the ones it
   *   started with until it starts again.
   * - `PUT /__test/verifier` with `real` or `stand-in` chooses the proof
   *   verifier `records` asks from now on.
   * - `POST /__test/proof-log/alarm` runs the alarm of the proof log's object,
   *   or with `?object=<name>` of the object of that name;
   *   `GET` answers `{alarm}`, the time it is set for or null, with
   *   `?object=<name>` of the object of that name.
   * - `PUT /__test/proof-log/extra-work` with `{due, every}` gives the object a
   *   second piece of timed work; `GET` answers `{runs}`, when it ran.
   * - `PUT /__test/proof-log/next-random` with 16 bytes in hex: the next
   *   challenge the object issues has them in place of random bytes.
   * - `PUT /__test/proof-log/card` writes a row of the card state table
   *   (CardToWrite); `PUT /__test/proof-log/cards`, a list of them, in one
   *   transaction.
   * - `POST /__test/proof-log/cards-copy` with `{what}`: "copy" copies the
   *   card state table as a publication does, "drop" drops the copy.
   * - `PUT /__test/proof-log/schema-version` and
   *   `PUT /__test/proof-log/rules-version` with `{to}`, "another" or "the
   *   build's", change the version the object's tables say they were made
   *   by, and the version of the rules its state says it was computed by.
   * - `POST /__test/proof-log/break` drops the tables the API reads.
   * - `POST /__test/proof-log/break-card` with `{scope_string, scoped_id,
   *   mend}` makes the stored slots of that card text that is not JSON, or,
   *   with `mend` true, what they were before that.
   * - `PUT /__test/proof-log/fail-writes` with `{what}`, a table, or
   *   `challenges.accepted`, or null: every write to it fails from now on,
   *   or none does.
   * - `POST /__test/proof-log/drop-newest-crls` drops the table of the newest
   *   CRLs, as on an object made before the build had it.
   * - `POST /__test/proof-log/rule-event` with a RuleEvent runs the record
   *   rules for it on the object's stored state and answers the result.
   * - `POST /__test/proof-log/rule-state` with `{scope_string, scoped_id}`
   *   answers a RuleStateAnswer: the latest valid date the rules read for
   *   that card, and the cards of every declared account of the scope.
   * - `GET /__test/proof-log/views` answers a StoredViews: every row of the
   *   views; `DELETE` clears them, and the object fills them from its
   *   records when it starts again; `DELETE /__test/proof-log/view-ordinals`
   *   empties `view_ordinals` alone. `POST /__test/proof-log/views-filled`
   *   answers once the running object has filled them or given up.
   * - `POST /__test/proof-log/page-plans` with a PagePlanQuestion answers
   *   PagePlans: the plan SQLite makes for each statement the pages' reads
   *   run.
   * - `GET /__test/proof-log/stored` answers a StoredProofLog: the rows the
   *   object keeps of its records, and the count and the proof log
   *   fingerprint of its row of the proof log. `GET /__test/proof-log/kept`
   *   answers a KeptRecords: only how many it keeps, and from which `seq`
   *   to which. `GET /__test/proof-log/tables` answers the names of the
   *   tables of its SQLite.
   * - `PUT /__test/proof-log/hash-delay` with milliseconds: from now on the
   *   object waits that long before it hashes a record it is asked to
   *   write, and other requests run meanwhile; `GET` answers `{hashes}`,
   *   how many times it has hashed one.
   * - `PUT /__test/proof-log/bucket-fault` with a BucketFault: from now on the
   *   object's writes or reads of one object of the data bucket go wrong
   *   in one way, or, with null, none does.
   * - `POST /__test/verify` with `{circuit, proof, publicInputs}` (hex, the
   *   inputs as a list) answers `{verified}`: the proof verifier's verdict.
   * - `GET /__test/newest-crls` answers what the proof log's object knows of
   *   the CRL archive (src/proof-log.ts, `newestCrls`).
   *
   * - `GET /__test/seen` answers the method and path of every request that
   *   reached this code since it was last asked, the doors aside: what
   *   Static Assets answers by itself is not among them.
   *
   * Anything else is the Worker's.
   */
  async fetch(request, deployedEnv, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    if (route === "GET /__test/seen") return json(seen.splice(0));
    if (!pathname.startsWith("/__test/")) seen.push(route);
    if (route === "PUT /__test/clock") {
      const ms = Number(await request.text());
      if (!Number.isSafeInteger(ms)) return new Response(null, { status: 400 });
      setTestClock(ms);
      return done();
    }
    if (route === "PUT /__test/settings") {
      testSettings = (await request.json()) as TestSettings;
      return done();
    }
    if (route === "PUT /__test/verifier") {
      const which = await request.text();
      if (which !== "real" && which !== "stand-in") return new Response(null, { status: 400 });
      standIn = which === "stand-in";
      return done();
    }
    const env = testEnv(deployedEnv);
    if (route === "POST /__test/proof-log/alarm") {
      // `?object=` names another object than the settings': the one of a proof log that was cleared (README.md, "清空測試的證明紀錄").
      const named = new URL(request.url).searchParams.get("object");
      await testProofLogOf(named === null ? env : { ...env, PROOF_LOG_OBJECT_NAME: named }).testRunAlarm();
      return done();
    }
    if (route === "GET /__test/proof-log/alarm") {
      const named = new URL(request.url).searchParams.get("object");
      return json({ alarm: await testProofLogOf(named === null ? env : { ...env, PROOF_LOG_OBJECT_NAME: named }).testAlarmTime() });
    }
    if (route === "PUT /__test/proof-log/extra-work") {
      const { due, every } = (await request.json()) as { due: number; every: number };
      await testProofLogOf(env).testSetExtraWork(due, every);
      return done();
    }
    if (route === "GET /__test/proof-log/extra-work") return json({ runs: await testProofLogOf(env).testExtraWorkRuns() });
    if (route === "PUT /__test/proof-log/next-random") {
      const random = bytesOfHex(await request.text());
      if (random.length !== 16) return new Response(null, { status: 400 });
      await testProofLogOf(env).testSetNextRandom(random);
      return done();
    }
    if (route === "PUT /__test/proof-log/card" || route === "PUT /__test/proof-log/cards") {
      const many = route === "PUT /__test/proof-log/cards";
      const body = (await request.json()) as CardToWrite | CardToWrite[];
      const cards: { scopeString: string; scopedId: string; card: CardState; seq: number }[] = [];
      for (const c of many ? (body as CardToWrite[]) : [body as CardToWrite]) {
        const slots = new Map<string, SlotState>();
        for (const [platform, s] of Object.entries(c.platforms)) {
          const slot = slotOfJson(s);
          if (slot === null) return new Response(null, { status: 400 });
          slots.set(platform, slot);
        }
        cards.push({ scopeString: c.scope_string, scopedId: c.scoped_id, card: { lastCardProof: parseDay(c.last_card_proof), proofsOnLastDate: c.proofs_on_last_date, slots }, seq: c.seq });
      }
      const proofLog = testProofLogOf(env);
      if (many) await proofLog.testWriteCards(cards);
      else await proofLog.testWriteCard(cards[0]!.scopeString, cards[0]!.scopedId, cards[0]!.card, cards[0]!.seq);
      return done();
    }
    if (route === "POST /__test/proof-log/cards-copy") {
      const { what } = (await request.json()) as { what: "copy" | "drop" };
      if (what !== "copy" && what !== "drop") return new Response(null, { status: 400 });
      await testProofLogOf(env).testCardsCopy(what);
      return done();
    }
    if (route === "PUT /__test/proof-log/schema-version") {
      const { to } = (await request.json()) as { to: "another" | "the build's" };
      await testProofLogOf(env).testSetStoredSchemaVersion(to);
      return done();
    }
    if (route === "PUT /__test/proof-log/rules-version") {
      const { to } = (await request.json()) as { to: "another" | "the build's" };
      await testProofLogOf(env).testSetStoredRulesVersion(to);
      return done();
    }
    if (route === "POST /__test/proof-log/break") {
      await testProofLogOf(env).testBreak();
      return done();
    }
    if (route === "POST /__test/proof-log/break-card") {
      const { scope_string, scoped_id, mend } = (await request.json()) as { scope_string: string; scoped_id: string; mend: boolean };
      await testProofLogOf(env).testBreakCard(scope_string, scoped_id, mend);
      return done();
    }
    if (route === "PUT /__test/proof-log/fail-writes") {
      const { what } = (await request.json()) as { what: FailingWrite | null };
      await testProofLogOf(env).testFailWritesTo(what);
      return done();
    }
    if (route === "POST /__test/proof-log/drop-newest-crls") {
      await testProofLogOf(env).testDropNewestCrls();
      return done();
    }
    if (route === "POST /__test/proof-log/rule-event") return json(await testProofLogOf(env).testApplyRuleEvent((await request.json()) as RuleEvent));
    if (route === "POST /__test/proof-log/rule-state") {
      const { scope_string, scoped_id } = (await request.json()) as { scope_string: string; scoped_id: string };
      return json(await testProofLogOf(env).testRuleState(scope_string, scoped_id));
    }
    if (route === "POST /__test/proof-log/page-plans") return json(await testProofLogOf(env).testPagePlans((await request.json()) as PagePlanQuestion));
    if (route === "POST /__test/proof-log/rebuild") return json({ begun: await testProofLogOf(env).testBeginRebuild(((await request.json()) as { token: string }).token) });
    if (route === "GET /__test/proof-log/rebuild") return json(await testProofLogOf(env).rebuildStatus());
    if (route === "GET /__test/proof-log/stored") return json(await testProofLogOf(env).testStored());
    if (route === "GET /__test/proof-log/kept") return json(await testProofLogOf(env).testKept());
    if (route === "GET /__test/proof-log/tables") return json(await testProofLogOf(env).testTables());
    if (route === "GET /__test/proof-log/views") return json(await testProofLogOf(env).testViews());
    if (route === "DELETE /__test/proof-log/views") {
      await testProofLogOf(env).testClearViews();
      return done();
    }
    if (route === "DELETE /__test/proof-log/view-ordinals") {
      await testProofLogOf(env).testForgetOrdinals();
      return done();
    }
    if (route === "POST /__test/proof-log/views-filled") {
      await testProofLogOf(env).testViewsFilled();
      return done();
    }
    if (route === "PUT /__test/proof-log/hash-delay") {
      const ms = Number(await request.text());
      if (!Number.isSafeInteger(ms) || ms < 0) return new Response(null, { status: 400 });
      await testProofLogOf(env).testSetHashDelay(ms);
      return done();
    }
    if (route === "GET /__test/proof-log/hash-delay") return json({ hashes: await testProofLogOf(env).testHashes() });
    if (route === "PUT /__test/proof-log/bucket-fault") {
      await testProofLogOf(env).testSetBucketFault((await request.json()) as BucketFault);
      return done();
    }
    if (route === "POST /__test/verify") {
      const { circuit, proof, publicInputs } = (await request.json()) as { circuit: string; proof: string; publicInputs: string[] };
      return json({ verified: await proofVerifier.verify(circuit, bytesOfHex(proof), publicInputs.map(bytesOfHex)) });
    }
    if (route === "GET /__test/newest-crls") return json(await proofLogOf(env).newestCrls());
    if (standIn && isApiPath(pathname)) return api(request, env, STAND_IN);
    return worker.fetch(request, env, ctx);
  },
  /** The schedule, with the settings the test replaced. */
  async scheduled(controller, deployedEnv): Promise<void> {
    return worker.scheduled(controller, testEnv(deployedEnv));
  },
} satisfies ExportedHandler<Env>;
