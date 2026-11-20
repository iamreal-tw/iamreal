// One card proof, as a state machine without a screen. First the card is
// confirmed, then the cardholder edits the card's whole list of accounts,
// then the list is declared (design/copy/card-proof.md; ADR-0017: one
// record states the card's whole list, at most one account per platform,
// and one card proof covers every platform; three clicks):
//
//   readCard()        read certificates (no PIN); check them; start the
//                     checks that need no signature: the server's config
//                     (CRL age bound, platform table), CRL, tree, circuit, CRS
//   checksDone()      resolves when every one of those passed; until then
//                     the screen shows no PIN field (`phase` is "checking")
//   confirmCard(pin)  card signs the scope string; scoped ID; card state;
//                     the card's list and each slot's counts (CardStatus)
//   choose(entries)   the account typed on each platform, or none; the list
//                     the card would sign and what it does on every platform
//                     (Consequence). No request, no signature
//   back()            from the consequence to the card's state again
//   proceed(list)     the caller confirms the list it showed; challenge,
//                     checked; card signs the declaration code; PIN dropped;
//                     prove; submit; what the server recorded, against what
//                     was shown (Done.mismatches)
//   resubmit()        after a network failure, the same record again
//   cancel()          drop everything
//
// The screen lists what the page is doing while the card is read and while
// the declaration is made; `onProgress` tells it each thing done (Progress).
// The events report; they change nothing the flow checks, nor the order.
//
// The card is asked for its first signature only after every check that
// needs no signature has passed: the certificate, the CRL (downloaded and
// verified), the tree, the serial number not in it, the circuit and CRS
// hashes. A card that fails one of them stops before any request carries
// its scoped ID; otherwise the server would see a scoped ID that asked for
// its state and then went silent, and could match that with the CRL its
// mirror served (ADR-0015, ADR-0016).
//
// Between the two signatures the PIN stays in this object while the
// cardholder reads and picks. If the second signature is not made within
// IDLE_MS of the first, the PIN, the certificate and the signature are
// dropped and the flow stops (`idle`); the caller starts again. This holds
// in every step between the two signatures, while the server is asked for
// the card's state or the challenge too, and the clock is read again just
// before the card is asked for the second signature.
//
// Once the flow stopped (cancel(), the wait ran out, a failed check), a step
// that was waiting writes nothing when its wait ends and sends nothing: each
// step checks after every await.
//
// A step called again while it is under way is out of order (`state`), like
// any step called in the wrong phase; the call under way goes on untouched.
// There is one timer for the wait for the second signature at most.
//
// A window the browser blocked (`popup_blocked`) sent nothing to the card:
// the step can be tried again, and the flow keeps what it held before it.
//
// Where each value comes from and goes to:
//   scope string     the public roster's, fixed for the page's roster
//                    (protocol/src/scope.ts); never from a server
//   platform table   the server's config: which platforms are offered,
//                    their display names, their `username` formats (read by
//                    the device itself, protocol/src/username-format.ts).
//                    Not where the scope string comes from
//   the list         the card's state (card-state), as the cardholder
//                    edits it; accounts on platforms the device does not
//                    know are kept as they are
//   current_time     the device's clock, as a Taiwan date; a challenge
//                    dated otherwise stops the flow
//   certificate,     from the card; stay in this object; dropped (bytes
//   signatures       zeroed) after the submission is accepted, on cancel,
//                    or when the flow stops
//   PIN              from the caller; kept in memory until the second
//                    signature is made, the flow stops, or IDLE_MS pass
//                    after the first; never stored
//   failures         returned to the caller only; no request carries them
import { type AcceptedKind, type CardStateResponse, type Fetch, type PlatformRow, ServerError, type Submission, requestCardState, requestChallenge, requestConfig, submitRecord } from "./api.ts";
import { type Card, CardError, type CardErrorCode, type CardSignature } from "./card/card.ts";
import { type CardCertificate, type CertificateProblem, cardKey, selectCertificate } from "./certificate.ts";
import type { TreeBuilder } from "./crl/build.ts";
import { type RevocationProblem, RevocationError, crlMaxAge, loadCrl } from "./crl/revocation.ts";
import type { AbsenceProof } from "./crl/tree.ts";
import { type IssuerKey, rsaVerify } from "./issuers.ts";
import { ArtifactError, CIRCUITS } from "./prover/artifacts.ts";
import { circuitInputs, circuitOf, expectedPublicInputs, wipeInputs } from "./prover/inputs.ts";
import type { Prover, ThreadMode } from "./prover/prover.ts";
import { PROOF_BYTES } from "./prover/prover.ts";
import { parseChallenge, currentTime } from "iamreal-protocol/challenge.ts";
import { type Day, formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import { type Account, declarationCode } from "iamreal-protocol/declaration-code.ts";
import { EMPTY_SLOT, type Kind, MAX_SWITCHES, type SlotState, applyList, dailyLimitReached } from "iamreal-protocol/roster-rules.ts";
import { type Roster, scopeOf } from "iamreal-protocol/scope.ts";
import { scopedId, scopedIdText, shortId } from "iamreal-protocol/scoped-id.ts";
import { byPlatform, isAnyUsername } from "iamreal-protocol/username-format.ts";
import type { CrlNumberStore } from "./storage.ts";
import { bytesOfBigint, equalBytes, wipe } from "iamreal-protocol/bytes.ts";

/** Why the flow stopped. Returned to the caller; never sent to the server (ADR-0016). */
export type Stop =
  /** `detail` is the short code the screen shows with `card_error` (CardError.detail). */
  | { code: "card"; card: CardErrorCode; detail?: string }
  /** `notAfter` (expired) and `notBefore` (not_yet_valid) are Taiwan dates, YYYY-MM-DD. */
  | { code: "certificate"; problem: CertificateProblem; notAfter?: string; notBefore?: string }
  | { code: "revocation"; problem: RevocationProblem }
  /** The card's certificate is on the CRL (revoked or suspended). */
  | { code: "revoked" }
  /** The card returned a signature that does not verify under its certificate's key. */
  | { code: "card_signature" }
  /** The challenge is not in its one spelling. */
  | { code: "challenge_malformed" }
  /** The challenge is not dated today (Taiwan, by the device's clock). */
  | { code: "challenge_not_today"; challengeDate: string; today: string }
  /**
   * The list is not possible by the roster rules:
   *   switch_limit      it switches a slot whose 5 switches are used up (`platform`)
   *   empty             the list is empty and the card declares no account
   *   daily_limit       the card has 3 valid records today
   */
  | { code: "blocked"; reason: "switch_limit" | "empty" | "daily_limit"; platform?: string }
  /** The second signature was not made within IDLE_MS of the first: the PIN, the certificate and the signature were dropped. */
  | { code: "idle" }
  /** A circuit or CRS file did not match its SHA-256, or could not be fetched. */
  | { code: "artifact"; path: string }
  /** The proof engine could not start or prove. */
  | { code: "engine"; detail: string }
  /** The proof is not 14,656 bytes, or its public inputs are not the ones the device built. */
  | { code: "proof_check" }
  /**
   * The server answered with an error, or a response the device cannot read.
   * `requestId` is the response's X-Request-Id, which the screen shows so
   * that the cardholder can report it (docs/api/card-proof.md).
   */
  | { code: "server"; server: string; status: number; requestId?: string }
  /** The account typed for `platform` is not in that platform's format. */
  | { code: "username"; platform: string }
  /**
   * The date changed after the list was confirmed (midnight passed before the
   * button was pressed, or while the challenge was on its way), and on the
   * new date the list would do something other than the screen said (a
   * correction turned into a switch). The card did not sign it.
   */
  | { code: "date_changed" }
  /** The caller called a step out of order. */
  | { code: "state" };

export class FlowStop extends Error {
  readonly stop: Stop;
  constructor(stop: Stop) {
    super(stop.code);
    this.stop = stop;
  }
}

export interface FlowDeps {
  /** Which roster's scope string the card signs. Fixed by the page's build, not by a server. */
  roster: Roster;
  /** The issuer keys the page trusts: MOICA_ISSUERS in the page, test keys in tests. */
  issuers: readonly IssuerKey[];
  /**
   * The platforms the page has its own definition of (src/platforms.ts). A
   * platform of the server's table is offered only if it is one of them;
   * any other is a platform the device does not know.
   */
  knownPlatforms: ReadonlySet<string>;
  /** The server's API. */
  fetch: Fetch;
  /** The data domain's files: the CRL archive (ADR-0027). Its origin is fixed by the page's build, not by a server. */
  dataFetch: Fetch;
  /** Milliseconds since the epoch (Date.now in the page). */
  clock: () => number;
  store: CrlNumberStore;
  card: Card;
  prover: Prover;
  startTreeBuilder: () => Promise<TreeBuilder>;
  /** Called once if a background step (CRL, tree, circuit) stops the flow, so the screen can say so before the next click. */
  onBackgroundStop?: (stop: Stop) => void;
  /** Step timings in milliseconds, for progress display and measurements. Stays on the device. */
  onTiming?: (step: string, ms: number) => void;
  /** Called once if the flow stops because IDLE_MS passed after the first signature (`idle`). */
  onIdle?: (stop: Stop) => void;
  /** Each thing the flow has done, for the screen's lists (Progress). Not called once the flow stopped. Stays on the device. */
  onProgress?: (step: Progress) => void;
  /** How long the PIN may wait between the two signatures; IDLE_MS unless a test shortens it. */
  idleMs?: number;
  /** Runs `f` after `ms` milliseconds; returns a function that cancels it. setTimeout in the page; tests replace it with the clock. */
  setTimer?: (ms: number, f: () => void) => () => void;
}

/** The longest the PIN, the certificate and the first signature wait for the second signature: 5 minutes. */
export const IDLE_MS = 5 * 60_000;

/**
 * What the flow has done, as it is done. Several happen at the same time
 * (config, circuit, engine, crl and tree run together after the card is
 * read), so they come in any order; each comes at most once per flow.
 *
 *   readCard():
 *     component      the card's reader answered (MOICA's component: its window is ready)
 *     certificates   the card returned its certificates
 *     certificate    one certificate passed the checks on the device
 *   the checks that need no signature (checksDone()):
 *     config         the server answered its CRL age bound and its platform table
 *     circuit        the circuit file matched its SHA-256
 *     engine         the proof engine is ready (the CRS matched its SHA-256)
 *     crl            the CRL was fetched and checked
 *     tree           the tree was built, and the serial number is not in it
 *   proceed():
 *     challenge      the challenge was fetched and checked
 *     signed         the card signed the declaration code, and it verified
 *     proved         the proof was made and passed the device's own check
 */
export type Progress = "component" | "certificates" | "certificate" | "config" | "circuit" | "engine" | "crl" | "tree" | "challenge" | "signed" | "proved";

/**
 * What the cardholder picks once the card's state is known: for every
 * platform the screen offers (CardStatus.slots with a row), the account
 * typed, or "" for none. Accounts on platforms the device does not know are
 * not in it: the flow keeps them in the list as they are.
 */
export type Choice = Readonly<Record<string, string>>;

export interface CardRead {
  /** The name on the certificate, for the screen only. */
  name: string;
  issuer: IssuerKey["name"];
}

/** One slot of the card as the server reports it (not checkable by the device), with what the device computes from it. */
export interface SlotStatus {
  platform: string;
  /**
   * The platform's row of the server's table; null for a platform the device
   * does not know, which the card has an account on: kept in the list as it
   * is, and not changed here.
   */
  row: PlatformRow | null;
  current: string | null;
  lastDeclared: string | null;
  /** 0 to 5 (0 for a platform the device does not know). */
  switchCount: number;
  correctionDate: string | null;
  /** Switches left by the roster rules: 5 minus the count. */
  switchesLeft: number;
  /** `correction_date` is today: changing the account today is a correction, not counted. */
  correctionToday: boolean;
}

export interface CardStatus {
  scopedId: string;
  shortId: string;
  lastCardProof: string | null;
  /**
   * Every platform of the server's table that has an entry in the card's
   * state, and every account of the card on a platform the device does not
   * know; in ascending order of platform.
   */
  slots: SlotStatus[];
  /** The platforms of the server's table the device knows (a row it can read, and a definition of its own), in ascending order. */
  tablePlatforms: string[];
  /** The card's list now: the `current` of every slot that has one, in ascending order of platform. */
  accounts: Account[];
  /**
   * The card has 3 valid records dated today (`last_card_proof` is today and
   * `proofs_on_last_date` is 3): no list can be declared today
   * (spec/roster-rules.md, check 6).
   */
  dailyLimit: boolean;
  today: string;
  /** The number of records of the roster the answer was computed at. */
  count: number;
}

/** What a list does on one platform, for the screen before the second signature. */
export interface ConsequenceRow {
  platform: string;
  /** The platform's row of the server's table; null for a platform the device does not know. */
  row: PlatformRow | null;
  /** The account of the list on this platform, or for `withdraw` the account withdrawn. */
  username: string;
  /** The kind by the roster rules (spec/roster-rules.md, "Event rules"). */
  kind: Kind;
  /** The slot's `current` before this card proof. */
  current: string | null;
  /** For a `correction` or a `switch`: the account replaced (`current`, or after a withdrawal `last_declared`). */
  previous: string | null;
  /** For a `switch`: the switches left after it by the rules; null otherwise. */
  switchesLeftAfter: number | null;
}

/** What a choice would do, for the screen before the second signature. */
export interface Consequence {
  /** The list the card will sign: in ascending order of platform, each platform at most once. */
  accounts: Account[];
  /** Every platform the list has a kind on (each account of the list, each account withdrawn), in ascending order of platform. */
  rows: ConsequenceRow[];
  /** The card had no valid record before: this would be its first. */
  firstRecord: boolean;
  today: string;
}

export interface Done {
  /**
   * The record's `seq` and hash, as the server answered the submission;
   * null if the submission's answer was lost and the record was found in
   * the card's state instead (resubmit(), `challenge_used`).
   */
  seq: number | null;
  recordHash: string | null;
  /**
   * What the server says the record is on each platform (`kinds`); null when
   * the record was found in the card's state, or the answer's `kinds` could
   * not be read. The record is in the roster either way.
   */
  kinds: AcceptedKind[] | null;
  /** What the screen said the list would do, before the card signed (Consequence.rows). */
  expected: ConsequenceRow[];
  /**
   * The platforms on which `kinds` differs from `expected` (another kind,
   * another account, or one of the two has the platform and the other not),
   * in ascending order. Empty when `kinds` is null: there is nothing to
   * compare. The server's answer cannot be checked here; a difference means
   * the card's state it sent, or this answer, was not what the roster holds.
   */
  mismatches: string[];
  firstRecord: boolean;
  date: string;
  scopedId: string;
  shortId: string;
  /** The list the card signed: what the record states. */
  accounts: Account[];
  record: Submission;
}

/**
 * Where the flow is. "checking": the card was read and the checks that need
 * no signature are running; the screen does not ask for the PIN yet.
 * "ready_for_pin": they all passed. "status_known": the card signed the
 * scope string and its state is known; the cardholder edits the list.
 * "chosen": the consequence of the list is shown; the next step is the
 * second signature. "signing": proceed() is asking for the challenge and the
 * second signature.
 */
export type Phase = "start" | "checking" | "ready_for_pin" | "status_known" | "chosen" | "signing" | "submitting" | "submit_failed" | "done" | "stopped";

interface BackgroundResult {
  tree: AbsenceProof;
  crlNumber: bigint;
  crlDate: Day;
  /** L, the CRL age bound in force (crlMaxAge of the server's figure). */
  maxAgeDays: number;
  /** The rows of the server's platform table the device can read. */
  platforms: readonly PlatformRow[];
}

interface Background {
  promise: Promise<BackgroundResult>;
  failed: Stop | null;
  /** Set when every check passed. */
  done: BackgroundResult | null;
}

export class CardProofFlow {
  private readonly deps: FlowDeps;
  private readonly scopeStringValue: string;
  private readonly scopeBytes: Uint8Array;
  private readonly idleMs: number;

  private phaseValue: Phase = "start";
  private stopped: Stop | null = null;
  private cert: CardCertificate | null = null;
  private cardPublicKey: CryptoKey | null = null;
  private background: Background | null = null;
  private pin: string | null = null;
  private scopeSignature: Uint8Array | null = null;
  private codeSignature: Uint8Array | null = null;
  private state: CardStateResponse | null = null;
  private status: CardStatus | null = null;
  private chosen: Consequence | null = null;
  /** The entries the consequence was computed from, to compute it again before the card signs. */
  private choice: Choice | null = null;
  private scopedIdValue: bigint | null = null;
  private submission: Submission | null = null;
  /** When the first signature was made (deps.clock), and the timer that ends the wait for the second. */
  private firstSignedAt: number | null = null;
  private cancelIdleTimer: (() => void) | null = null;
  /** The card was asked for the second signature (the PIN went to it); the wait no longer applies. */
  private secondSignAsked = false;
  /**
   * readCard() or confirmCard() is under way. Both wait without leaving
   * their phase, so the phase alone would let a second call in: the card
   * asked again, another card-state, another timer.
   */
  private inStep = false;
  /** resubmit() was called: the submission's earlier answer may have been lost. */
  private resubmitted = false;

  constructor(deps: FlowDeps) {
    this.deps = deps;
    this.scopeStringValue = scopeOf(deps.roster);
    this.scopeBytes = new TextEncoder().encode(this.scopeStringValue);
    this.idleMs = deps.idleMs ?? IDLE_MS;
  }

  get phase(): Phase {
    return this.phaseValue;
  }

  get scopeString(): string {
    return this.scopeStringValue;
  }

  /**
   * The reason the flow stopped for good, if it did. A FlowStop thrown while
   * this is null (a wrong PIN, a blocked window, a choice that is not
   * possible, a submission that did not get through) leaves the step to be
   * tried again.
   */
  get stop(): Stop | null {
    return this.stopped;
  }

  private today(): Day {
    return taiwanDay(this.deps.clock());
  }

  /** Tells the screen a thing is done, unless the flow stopped. */
  private progress(step: Progress): void {
    if (!this.stopped) this.deps.onProgress?.(step);
  }

  private timed<T>(step: string, p: Promise<T>): Promise<T> {
    const t = performance.now();
    return p.then((v) => {
      this.deps.onTiming?.(step, performance.now() - t);
      return v;
    });
  }

  /** Stops the flow: drops every secret and remembers why. */
  private fail(stop: Stop): never {
    this.end(stop);
    throw new FlowStop(this.stopped!);
  }

  private end(stop: Stop): void {
    if (!this.stopped) this.stopped = stop;
    this.phaseValue = "stopped";
    this.dropSecrets();
    this.dropState();
  }

  /** The card's scoped ID, state, list and record: not secret, but not kept once the card proof ended. */
  private dropState(): void {
    this.scopedIdValue = null;
    this.status = null;
    this.state = null;
    this.chosen = null;
    this.choice = null;
    this.submission = null;
  }

  private expect(...phases: Phase[]): void {
    if (this.stopped) throw new FlowStop(this.stopped);
    if (!phases.includes(this.phaseValue)) throw new FlowStop({ code: "state" });
  }

  /**
   * Runs a step that waits in its own phase (readCard, confirmCard). A call
   * while one is under way is out of order (`state`): it touches nothing,
   * and the one under way goes on.
   */
  private async once<T>(step: () => Promise<T>): Promise<T> {
    if (this.inStep) throw new FlowStop({ code: "state" });
    this.inStep = true;
    try {
      return await step();
    } finally {
      this.inStep = false;
    }
  }

  /** True if IDLE_MS passed since the first signature while the second was not made. */
  private idleExpired(): boolean {
    return this.firstSignedAt !== null && this.deps.clock() - this.firstSignedAt >= this.idleMs;
  }

  /** The wait for the second signature is over: everything is dropped, and the caller is told. */
  private expireIdle(): void {
    if (this.stopped) return;
    this.end({ code: "idle" });
    this.deps.onIdle?.(this.stopped!);
  }

  /** Throws `idle` (and ends the flow) if the wait for the second signature is over. */
  private checkIdle(): void {
    if (!this.idleExpired()) return;
    this.expireIdle();
    throw new FlowStop(this.stopped!);
  }

  /**
   * Called after every await: if the flow stopped meanwhile (cancel(), the
   * wait ran out), the step goes no further. `drop` are bytes the step holds
   * and has not stored; they are wiped.
   */
  private live(...drop: (Uint8Array | null | undefined)[]): void {
    if (!this.stopped) return;
    for (const b of drop) wipe(b);
    throw new FlowStop(this.stopped);
  }

  private startIdleTimer(): void {
    // One wait, one timer: a timer left from an earlier start would end the
    // flow later, whatever step it is in by then.
    this.cancelIdleTimer?.();
    this.cancelIdleTimer = null;
    this.firstSignedAt = this.deps.clock();
    const set =
      this.deps.setTimer ??
      ((ms: number, f: () => void) => {
        const t = setTimeout(f, ms);
        return () => clearTimeout(t);
      });
    this.cancelIdleTimer = set(this.idleMs, () => {
      this.cancelIdleTimer = null;
      // Any step between the two signatures, while the server is asked for
      // the card's state or the challenge too. Once the card was asked for
      // the second signature, the PIN is with it already: the bridge's own
      // limits end that step (src/card/hipki.ts), and the PIN is dropped
      // when it ends. A blocked window brings proceed() back to "chosen",
      // where it reads the clock itself.
      if (!this.secondSignAsked) this.expireIdle();
    });
  }

  private stopIdleTimer(): void {
    this.cancelIdleTimer?.();
    this.cancelIdleTimer = null;
    this.firstSignedAt = null;
    this.secondSignAsked = false;
  }

  private dropSecrets(): void {
    this.stopIdleTimer();
    this.pin = null;
    wipe(this.scopeSignature);
    wipe(this.codeSignature);
    this.scopeSignature = null;
    this.codeSignature = null;
    if (this.cert) {
      wipe(this.cert.der);
      wipe(this.cert.tbs);
      wipe(this.cert.issuerSignature);
    }
    this.cert = null;
    this.cardPublicKey = null;
  }

  /** Drops everything. The flow cannot continue. */
  cancel(): void {
    this.dropSecrets();
    this.dropState();
    if (!this.stopped) this.stopped = { code: "state" };
    this.phaseValue = "stopped";
  }

  /**
   * The card's reader reports which certificate made a signature (MOICA's
   * component does): it must be the one chosen when the card was read.
   */
  private checkSigner(s: CardSignature): void {
    const same = s.certificate === null || equalBytes(s.certificate, this.cert!.der);
    // The reported copy is not needed once compared.
    wipe(s.certificate);
    if (!same) {
      wipe(s.signature);
      this.fail({ code: "card", card: "card_error", detail: "certificate_mismatch" });
    }
  }

  /**
   * Again on `today`: the certificate is still valid and the CRL no older
   * than L days. Both were checked when the card was read; a card proof can
   * cross midnight since. proceed() calls it before it asks for the challenge
   * and again before the second signature.
   */
  private checkStillValid(today: Day): void {
    const cert = this.cert!;
    const now = currentTime(today);
    if (now > cert.notAfter) this.fail({ code: "certificate", problem: "expired", notAfter: certificateDay(cert.notAfter) });
    if (now < cert.notBefore) this.fail({ code: "certificate", problem: "not_yet_valid", notBefore: certificateDay(cert.notBefore) });
    const bg = this.background!.done!;
    if (today - bg.crlDate > bg.maxAgeDays) this.fail({ code: "revocation", problem: { code: "crl_stale", days: today - bg.crlDate, maxDays: bg.maxAgeDays } });
  }

  // Step 1: read the certificates (no PIN) ------------------------------------

  async readCard(): Promise<CardRead> {
    this.expect("start");
    return this.once(() => this.readCardStep());
  }

  private async readCardStep(): Promise<CardRead> {
    let ders: Uint8Array[];
    try {
      ders = await this.deps.card.readCertificates(() => this.progress("component"));
    } catch (e) {
      this.live();
      // A blocked window sent nothing to the card: the same step can be tried again.
      if (e instanceof CardError && e.code === "popup_blocked") throw new FlowStop(cardStop(e));
      this.fail(cardStop(e));
    }
    this.live(...ders);
    this.progress("certificates");
    const today = this.today();
    const sel = await selectCertificate(ders, today, this.deps.issuers);
    // Only the chosen certificate is kept; the others (the encryption
    // certificate, with the same name) are wiped now.
    for (const d of ders) if (!sel.ok || d !== sel.cert.der) wipe(d);
    this.live(sel.ok ? sel.cert.der : null);
    if (!sel.ok) {
      const notAfter = sel.notAfter !== undefined ? certificateDay(sel.notAfter) : undefined;
      const notBefore = sel.notBefore !== undefined ? certificateDay(sel.notBefore) : undefined;
      this.fail({ code: "certificate", problem: sel.problem, ...(notAfter && { notAfter }), ...(notBefore && { notBefore }) });
    }
    const key = await cardKey(sel.cert);
    this.live(sel.cert.der);
    this.cert = sel.cert;
    this.cardPublicKey = key;
    this.progress("certificate");
    this.background = this.startBackground(sel.cert, today);
    this.phaseValue = "checking";
    this.background.promise.then(
      () => {
        if (this.phaseValue === "checking") this.phaseValue = "ready_for_pin";
      },
      () => undefined,
    );
    return { name: sel.cert.name, issuer: sel.cert.issuer.name };
  }

  /**
   * The checks that need no signature, started as soon as the card is read:
   * the server's config (the CRL age bound, and the platform table: without
   * one it can read the device has nothing to offer, docs/api/card-proof.md),
   * the CRL, the tree and the serial number's absence, the circuit's and the
   * CRS's hashes (the engine's start).
   */
  private startBackground(cert: CardCertificate, today: Day): Background {
    const bg: Background = { failed: null, done: null, promise: Promise.resolve() as never };
    const circuit = circuitOf(cert);
    const serial = cert.serial;
    const issuer = cert.issuer;
    // Progress only while no check has failed: the screen shows the first failure.
    const progress = (step: Progress): void => {
      if (!bg.failed) this.progress(step);
    };
    const run = async () => {
      const builderP = this.timed("tree_workers", this.deps.startTreeBuilder());
      const circuitP = this.deps.prover.preloadCircuit(circuit);
      circuitP.catch(() => undefined); // awaited below; a failure is reported there
      builderP.catch(() => undefined);
      // The screen hears of the circuit and the engine as soon as each is
      // ready; the checks below still await them in their order.
      circuitP.then(() => progress("circuit"), () => undefined);
      this.deps.prover.ready().then(() => progress("engine"), () => undefined);
      let builder: TreeBuilder | null = null;
      try {
        const config = await this.timed("config", requestConfig(this.deps.fetch));
        progress("config");
        const maxAgeDays = crlMaxAge(config.crlMaxAgeDays);
        const crl = await this.timed("crl", loadCrl({ fetch: this.deps.dataFetch, issuer, today, maxAgeDays, store: this.deps.store }));
        progress("crl");
        builder = await builderP;
        const result = await this.timed("tree_build", builder.build(crl.keys, crl.count, serial));
        if (result.inTree) throw new FlowStop({ code: "revoked" });
        progress("tree");
        await circuitP;
        await this.deps.prover.ready();
        bg.done = { tree: result.proof, crlNumber: crl.crlNumber, crlDate: crl.crlDay, maxAgeDays, platforms: config.platforms.filter((r) => this.deps.knownPlatforms.has(r.platform)) };
        return bg.done;
      } finally {
        builderP.then((b) => b.close(), () => undefined);
      }
    };
    bg.promise = run().catch((e: unknown) => {
      const stop = toStop(e);
      bg.failed = stop;
      if (this.phaseValue !== "done" && this.phaseValue !== "stopped") this.deps.onBackgroundStop?.(stop);
      throw new FlowStop(stop);
    });
    bg.promise.catch(() => undefined);
    return bg;
  }

  private checkBackground(): void {
    if (this.background?.failed) this.fail(this.background.failed);
  }

  /**
   * Resolves when every check that needs no signature has passed (phase
   * "ready_for_pin"); rejects with the FlowStop of the first that did not.
   */
  async checksDone(): Promise<void> {
    this.expect("checking", "ready_for_pin");
    try {
      await this.background!.promise;
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    }
    this.live();
  }

  // Step 2: the card signs the scope string -----------------------------------

  async confirmCard(pin: string): Promise<CardStatus> {
    this.expect("checking", "ready_for_pin");
    return this.once(() => this.confirmCardStep(pin));
  }

  private async confirmCardStep(pin: string): Promise<CardStatus> {
    // Nothing is signed, and no request carries the scoped ID, before these pass.
    await this.checksDone();
    let signed: CardSignature;
    try {
      signed = await this.deps.card.sign(this.scopeBytes, pin);
    } catch (e) {
      this.live();
      // A wrong PIN or a blocked window does not end the flow: the screen asks
      // again. Nothing is kept, the PIN included.
      if (e instanceof CardError && (e.code === "pin_incorrect" || e.code === "popup_blocked")) throw new FlowStop(cardStop(e));
      this.fail(cardStop(e));
    }
    this.live(signed.signature, signed.certificate);
    this.checkSigner(signed);
    const sig = signed.signature;
    const verified = await rsaVerify(this.cardPublicKey!, 2048, sig, this.scopeBytes);
    this.live(sig);
    if (!verified) {
      wipe(sig);
      this.fail({ code: "card_signature" });
    }
    this.pin = pin;
    this.scopeSignature = sig;
    // The wait for the second signature starts now (IDLE_MS).
    this.startIdleTimer();
    const id = await scopedId(sig, (a, b) => this.deps.prover.hash2(a, b));
    this.live();
    this.scopedIdValue = id;
    const idText = scopedIdText(id);
    let state: CardStateResponse;
    try {
      state = await requestCardState(this.deps.fetch, this.scopeStringValue, idText, this.background!.done!.platforms, this.today());
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    }
    // The wait may have run out while the server answered.
    this.live();
    this.checkIdle();
    const today = this.today();
    this.state = state;
    this.status = statusOf(state, this.background!.done!.platforms, idText, today);
    this.phaseValue = "status_known";
    return this.status;
  }

  /** The card's state from confirmCard(), while the flow waits for a choice or its confirmation; null otherwise. */
  get cardStatus(): CardStatus | null {
    return this.phaseValue === "status_known" || this.phaseValue === "chosen" ? this.status : null;
  }

  // The cardholder edits the list; nothing is signed or sent -------------------

  /**
   * What the list `entries` makes would do; the next step is proceed(). A
   * list that is not possible (a switch the rules or the web page do not
   * allow, an empty list for a card that declares nothing, 3 records today)
   * or an account not in its platform's format throws without ending the
   * flow: the cardholder can change the list again. Nothing is signed,
   * nothing is sent.
   */
  choose(entries: Choice): Consequence {
    this.expect("status_known", "chosen");
    this.checkIdle();
    const consequence = this.consequenceOf(entries);
    this.chosen = consequence;
    this.choice = { ...entries };
    this.phaseValue = "chosen";
    return consequence;
  }

  /** Back from the consequence to the card's state. Nothing is signed or asked again. */
  back(): CardStatus {
    this.expect("status_known", "chosen");
    this.checkIdle();
    this.chosen = null;
    this.choice = null;
    this.phaseValue = "status_known";
    return this.status!;
  }

  /**
   * The list and what it does on each platform, by the event rules of
   * spec/roster-rules.md against the slots the server reported, on today's
   * date by the device's clock. Every platform offered (a slot with a row)
   * must be in `entries`, and nothing else: an account on a platform the
   * device does not know is kept as the server reported it, not taken from
   * the caller.
   */
  private consequenceOf(entries: Choice): Consequence {
    const status = this.status!;
    const state = this.state!;
    const today = this.today();
    const offered = status.slots.filter((s) => s.row !== null);
    const keys = Object.keys(entries);
    if (keys.length !== offered.length || offered.some((s) => !Object.prototype.hasOwnProperty.call(entries, s.platform) || typeof entries[s.platform] !== "string")) {
      throw new FlowStop({ code: "state" });
    }
    const list = new Map<string, string>();
    for (const s of offered) {
      const u = entries[s.platform]!;
      if (u === "") continue;
      if (!s.row!.format.accepts(u)) throw new FlowStop({ code: "username", platform: s.platform });
      list.set(s.platform, u);
    }
    for (const k of state.kept) list.set(k.platform, k.username);

    const accounts = [...list].map(([platform, username]) => Object.freeze({ platform, username })).sort(byPlatform);

    // The roster rules (checks 5 and 6), on the slots the server reported. A
    // platform the device does not know has only its account: kept as it is,
    // it is the account declared there, whatever the rest of its slot says.
    const before = new Map<string, { slot: SlotState; row: PlatformRow | null }>(
      status.slots.map((s) => [s.platform, { row: s.row, slot: s.row === null ? { current: s.current, lastDeclared: s.current, switchCount: 0, correctionDate: null } : (state.slots.get(s.platform) ?? EMPTY_SLOT) }]),
    );
    const card = { lastCardProof: state.lastCardProof, proofsOnLastDate: state.proofsOnLastDate, slots: new Map([...before].map(([p, b]) => [p, b.slot])) };
    // The table the rules go through: the rows the device read from the
    // server, and for a platform it does not know a row that takes the
    // account as kept (it was checked as any username when it was read).
    const table = status.slots.map((s) => s.row ?? keptRow(s.platform));
    const { result } = applyList(table, card, accounts, today);
    if (!result.valid) throw new FlowStop(result.reason === "switch_limit" ? { code: "blocked", reason: result.reason, platform: result.blockedPlatform } : { code: "blocked", reason: result.reason });
    const rows: ConsequenceRow[] = result.kinds.map(({ platform, kind }) => {
      const { slot, row } = before.get(platform)!;
      const entry = list.get(platform) ?? null;
      return {
        platform,
        row,
        username: kind === "withdraw" ? slot.current! : entry!,
        kind,
        current: slot.current,
        previous: kind === "switch" || kind === "correction" ? (slot.current ?? slot.lastDeclared) : null,
        switchesLeftAfter: kind === "switch" ? MAX_SWITCHES - slot.switchCount - 1 : null,
      };
    });
    // What the screen shows is what the card signs: the rows that are not a
    // withdrawal are the list, account by account, in its order.
    if (!sameList(rows.filter((r) => r.kind !== "withdraw"), accounts)) throw new FlowStop({ code: "state" });
    return { accounts, rows, firstRecord: state.lastCardProof === null, today: formatDay(today) };
  }

  /**
   * The chosen list, worked out again on today's date by the device's clock:
   * the same list must do on every platform what the screen said. Only the
   * date can make it differ (the card's state is the one the screen showed),
   * so a difference, or a list no longer possible, is `date_changed`.
   */
  private sameAsShown(): void {
    const chosen = this.chosen!;
    let again: Consequence;
    try {
      again = this.consequenceOf(this.choice!);
    } catch (e) {
      const stop = toStop(e);
      this.fail(stop.code === "blocked" ? { code: "date_changed" } : stop);
    }
    // The same list from the same choice: a different list is a program error.
    if (!sameList(again.accounts, chosen.accounts)) this.fail({ code: "state" });
    if (!sameRows(again.rows, chosen.rows)) this.fail({ code: "date_changed" });
  }

  // Step 3: the card signs the declaration code, then prove and submit --------

  /**
   * `confirmed` is the list the consequence showed the cardholder and they
   * confirmed (Consequence.accounts), in its order. The card signs only if it
   * is the list the declaration code will name, and only if the list still
   * does on every platform what was shown, with today's date.
   */
  async proceed(confirmed: readonly Account[]): Promise<Done> {
    this.expect("chosen");
    this.checkIdle();
    const chosen = this.chosen!;
    if (!sameList(confirmed, chosen.accounts)) this.fail({ code: "state" });
    // Again, with today's date: a list that would now do something else is not signed.
    this.sameAsShown();
    this.checkBackground();
    // The certificate and the CRL, again with today's date: the card may have
    // been read before midnight. No challenge is asked for if they no longer pass.
    this.checkStillValid(this.today());
    const accounts = chosen.accounts;
    this.phaseValue = "signing";

    let challenge: unknown;
    try {
      challenge = await requestChallenge(this.deps.fetch);
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    }
    this.live();
    const challengeDay = parseChallenge(challenge);
    if (challengeDay === null) this.fail({ code: "challenge_malformed" });
    const today = this.today();
    if (challengeDay !== today) {
      this.fail({ code: "challenge_not_today", challengeDate: formatDay(challengeDay), today: formatDay(today) });
    }
    // Midnight may have passed while the server answered.
    this.checkStillValid(today);
    // Midnight may have passed while the challenge was on its way. The record
    // is dated the challenge's date (today, checked above): what the list
    // does is worked out again on it, and a list that would now do something
    // other than the screen said (a correction that is a switch on the new
    // date) is not signed.
    this.sameAsShown();
    this.progress("challenge");
    const challengeText = challenge as string;
    const code = await declarationCode(this.scopeStringValue, accounts, challengeText);
    this.live();
    // The clock again, right before the card is asked: the server may have
    // held the challenge, and the timer may not have run (a background tab).
    this.checkIdle();

    let signed: CardSignature;
    this.secondSignAsked = true;
    try {
      signed = await this.deps.card.sign(code, this.pin!);
    } catch (e) {
      this.secondSignAsked = false;
      this.live();
      if (e instanceof CardError && e.code === "popup_blocked") {
        // Nothing reached the card. The flow is back where it was; the wait
        // for the second signature still counts from the first.
        this.phaseValue = "chosen";
        this.checkIdle();
        throw new FlowStop(cardStop(e));
      }
      this.fail(cardStop(e));
    }
    // The second signature is made: the PIN is not needed again.
    this.pin = null;
    this.stopIdleTimer();
    this.live(signed.signature, signed.certificate);
    this.checkSigner(signed);
    const sig = signed.signature;
    const verified = await rsaVerify(this.cardPublicKey!, 2048, sig, code);
    this.live(sig);
    if (!verified) {
      wipe(sig);
      this.fail({ code: "card_signature" });
    }
    this.codeSignature = sig;
    this.progress("signed");

    let bg;
    try {
      bg = await this.background!.promise;
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    }
    this.live();
    const cert = this.cert!;
    const ct = currentTime(today);
    const circuit = circuitOf(cert);
    const inputs = circuitInputs({
      cert,
      tree: bg.tree,
      currentTime: ct,
      scope: this.scopeBytes,
      scopeSignature: this.scopeSignature!,
      declarationCode: code,
      declarationCodeSignature: sig,
    });
    let proof;
    try {
      proof = await this.timed("proof", this.deps.prover.prove(circuit, inputs));
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    } finally {
      // The input map holds the certificate and both signatures too.
      wipeInputs(inputs);
    }
    this.live();
    const expected = expectedPublicInputs(cert, bg.tree.root, ct, this.scopedIdValue!, this.scopeBytes, code);
    if (
      proof.proof.length !== PROOF_BYTES ||
      proof.publicInputs.length !== CIRCUITS[circuit].publicInputs ||
      proof.publicInputs.length !== expected.length ||
      proof.publicInputs.some((x, i) => x !== expected[i])
    ) {
      this.fail({ code: "proof_check" });
    }
    this.progress("proved");
    this.submission = {
      scope_string: this.scopeStringValue,
      scoped_id: this.status!.scopedId,
      accounts: accounts.map((a) => ({ platform: a.platform, username: a.username })),
      challenge: challengeText,
      issuer: cert.issuer.name,
      smt_root: bytesToHex(bytesOfBigint(bg.tree.root, 32)),
      circuit: CIRCUITS[circuit].vkSha256,
      proof: base64(proof.proof),
    };
    // The proof holds everything the server needs; the certificate and the
    // signatures are no longer needed by anyone.
    this.dropSecrets();
    this.phaseValue = "submitting";
    return this.submit();
  }

  private async submit(): Promise<Done> {
    const s = this.submission!;
    try {
      const accepted = await this.timed("submit", submitRecord(this.deps.fetch, s));
      this.live();
      return this.done(s, { seq: accepted.seq, recordHash: accepted.recordHash, kinds: accepted.kinds });
    } catch (e) {
      this.live();
      // Transient: no answer, rate limited, or a server failure. `crl_stale`
      // (503) is the server refusing every card proof until MOICA's CRL is
      // fresh again: not something a resubmission fixes.
      if (e instanceof ServerError && (e.code === "network" || e.status === 429 || (e.status >= 500 && e.code !== "crl_stale"))) {
        // The record can be sent again as it is (up to 5 submissions per challenge).
        this.phaseValue = "submit_failed";
        throw new FlowStop({ code: "server", server: e.code, status: e.status });
      }
      if (this.resubmitted && e instanceof ServerError && e.code === "challenge_used") return this.foundInCardState(s, e);
      this.fail(toStop(e));
    }
  }

  /**
   * The card proof is done. What the server says it recorded on each
   * platform (`kinds`) is compared with what the screen said before the card
   * signed (Consequence.rows): every difference is a platform in
   * `mismatches`, for the screen to tell the cardholder (docs/api/card-proof.md
   * cannot be checked by the device; a server that reported a wrong state, for
   * example a `correction_date` that made a switch look free, shows here).
   */
  private done(s: Submission, r: Pick<Done, "seq" | "recordHash" | "kinds">): Done {
    this.phaseValue = "done";
    this.submission = null;
    const expected = this.chosen!.rows;
    return {
      ...r,
      expected,
      mismatches: r.kinds === null ? [] : mismatchesOf(expected, r.kinds),
      firstRecord: this.chosen!.firstRecord,
      date: s.challenge.slice(0, 10),
      scopedId: s.scoped_id,
      shortId: shortId(s.scoped_id),
      accounts: s.accounts,
      record: s,
    };
  }

  /**
   * A resubmission was answered `challenge_used`: a record was accepted for
   * this challenge, which no other card proof has. The earlier submission
   * whose answer was lost (no answer in time, a dropped connection) may have
   * reached the server after all. The card's state, asked again, says
   * whether this card proof's record is in the roster: the card's list is
   * the list submitted (every platform the device knows has the list's
   * account as `current`, or none where the list has none; every account
   * kept on a platform it does not know is the list's) and
   * `last_card_proof` is the record's date. Then the card proof is done
   * (without `seq`, and without `kinds`: what the server recorded on each
   * platform is not known); otherwise the flow stops on the server's
   * `challenge_used`. The request carries the scoped ID the submission
   * carried already.
   */
  private async foundInCardState(s: Submission, used: ServerError): Promise<Done> {
    let state: CardStateResponse;
    try {
      state = await requestCardState(this.deps.fetch, s.scope_string, s.scoped_id, this.background!.done!.platforms, this.today());
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    }
    this.live();
    const recordDay = parseDay(s.challenge.slice(0, 10));
    const now: Account[] = [...[...state.slots].flatMap(([platform, slot]) => (slot.current === null ? [] : [{ platform, username: slot.current }])), ...state.kept].sort(byPlatform);
    if (state.lastCardProof !== recordDay || !sameList(now, s.accounts)) this.fail(toStop(used));
    return this.done(s, { seq: null, recordHash: null, kinds: null });
  }

  /**
   * Sends the same record again after a network failure. No new signature.
   * If the server says a record was accepted for its challenge already, the
   * card's state says whether it is this one (foundInCardState).
   */
  async resubmit(): Promise<Done> {
    this.expect("submit_failed");
    this.phaseValue = "submitting";
    this.resubmitted = true;
    return this.submit();
  }

  /** How the engine runs, for the screen's time estimate. */
  async threadMode(): Promise<ThreadMode> {
    return this.deps.prover.ready();
  }
}

/**
 * The row the roster rules get for a platform the device does not know: the
 * server's table has no row the device can read, so it has no format to
 * check. Every username the device kept passed isAnyUsername when the
 * card's state was read (api.ts); the rules are given exactly that check.
 * It is never shown and never offered.
 */
function keptRow(platform: string): PlatformRow {
  return { platform, displayName: platform, format: { text: "", min: 1, max: Number.MAX_SAFE_INTEGER, accepts: isAnyUsername } };
}

/** The card's state as the screen shows it, with what the device computes from it on `today`. */
function statusOf(state: CardStateResponse, table: readonly PlatformRow[], idText: string, today: Day): CardStatus {
  const slots: SlotStatus[] = [];
  for (const row of table) {
    const slot = state.slots.get(row.platform);
    // A platform of the table without an entry in the card's state is not offered (docs/api/card-proof.md).
    if (!slot) continue;
    slots.push({
      platform: row.platform,
      row,
      current: slot.current,
      lastDeclared: slot.lastDeclared,
      switchCount: slot.switchCount,
      correctionDate: slot.correctionDate === null ? null : formatDay(slot.correctionDate),
      switchesLeft: MAX_SWITCHES - slot.switchCount,
      correctionToday: slot.correctionDate === today,
    });
  }
  for (const k of state.kept) {
    slots.push({ platform: k.platform, row: null, current: k.username, lastDeclared: k.username, switchCount: 0, correctionDate: null, switchesLeft: MAX_SWITCHES, correctionToday: false });
  }
  slots.sort(byPlatform);
  return {
    scopedId: idText,
    shortId: shortId(idText),
    lastCardProof: state.lastCardProof === null ? null : formatDay(state.lastCardProof),
    slots,
    tablePlatforms: table.map((r) => r.platform),
    accounts: slots.flatMap((s) => (s.current === null ? [] : [Object.freeze({ platform: s.platform, username: s.current })])),
    dailyLimit: dailyLimitReached(state, today),
    today: formatDay(today),
    count: state.count,
  };
}

/** Two lists with the same accounts in the same order. */
function sameList(a: readonly Account[], b: readonly Account[]): boolean {
  return a.length === b.length && a.every((x, i) => x.platform === b[i]!.platform && x.username === b[i]!.username);
}

/** Two consequences that do the same on every platform. */
function sameRows(a: readonly ConsequenceRow[], b: readonly ConsequenceRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i]!;
      return x.platform === y.platform && x.username === y.username && x.kind === y.kind && x.switchesLeftAfter === y.switchesLeftAfter;
    })
  );
}

/** The platforms on which the server's kinds and the expected rows differ: kind, account, or presence. */
function mismatchesOf(expected: readonly ConsequenceRow[], kinds: readonly AcceptedKind[]): string[] {
  const platforms = [...new Set([...expected.map((r) => r.platform), ...kinds.map((k) => k.platform)])].sort();
  return platforms.filter((p) => {
    const e = expected.find((r) => r.platform === p);
    const k = kinds.find((r) => r.platform === p);
    return !e || !k || e.kind !== k.kind || e.username !== k.username;
  });
}

function toStop(e: unknown): Stop {
  if (e instanceof FlowStop) return e.stop;
  if (e instanceof RevocationError) return { code: "revocation", problem: e.problem };
  if (e instanceof ArtifactError) return { code: "artifact", path: e.path };
  if (e instanceof ServerError) return { code: "server", server: e.code, status: e.status, ...(e.requestId && { requestId: e.requestId }) };
  if (e instanceof CardError) return cardStop(e);
  return { code: "engine", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
}

function cardStop(e: unknown): Stop {
  if (!(e instanceof CardError)) return { code: "card", card: "card_error" };
  return { code: "card", card: e.code, ...(e.detail && { detail: e.detail }) };
}

/** A certificate's time, YYMMDDHHMMSS (UTC), as its Taiwan date. */
function certificateDay(t: bigint): string {
  const s = t.toString().padStart(12, "0");
  const ms = Date.UTC(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)));
  return formatDay(taiwanDay(ms));
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
