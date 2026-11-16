// One card proof, as a state machine without a screen. First the card is
// confirmed, then the cardholder picks what to do, then the declaration is
// made (docs/design/principles.md, "輸入 PIN 之前的畫面"; three clicks):
//
//   readCard()        read certificates (no PIN); check them; start the
//                     checks that need no signature: CRL, tree, circuit, CRS
//   checksDone()      resolves when every one of those passed; until then
//                     the screen shows no PIN field (`phase` is "checking")
//   confirmCard(pin)  card signs the scope string; scoped ID; card state;
//                     what each choice would be (CardStatus.options)
//   choose(choice)    declare an account, or withdraw; the consequence. No
//                     request, no signature
//   back()            from the consequence to the card's state again
//   proceed(account)  the caller confirms the account it showed; challenge,
//                     checked; card signs the declaration code; PIN dropped;
//                     prove; submit
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
//   scope string     the table in spec/scope.ts, by the platform picked on
//                    the screen; never from a server
//   current_time     the device's clock, as a Taiwan date; a challenge
//                    dated otherwise stops the flow
//   certificate,     from the card; stay in this object; dropped (bytes
//   signatures       zeroed) after the submission is accepted, on cancel,
//                    or when the flow stops
//   PIN              from the caller; kept in memory until the second
//                    signature is made, the flow stops, or IDLE_MS pass
//                    after the first; never stored
//   failures         returned to the caller only; no request carries them
import { type CardStateResponse, type Fetch, ServerError, type Submission, requestCardState, requestChallenge, requestCrlMaxAge, submitRecord } from "./api.ts";
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
import { parseChallenge, currentTime } from "./spec/challenge.ts";
import { type Day, formatDay, parseDay, taiwanDay } from "./spec/date.ts";
import { type Action, declarationCode } from "./spec/declaration-code.ts";
import { type CardState, type Outcome, dailyLimitReached, declareOutcome, nextSwitchDay, switchesInWindow, switchesLeft, withdrawOutcome } from "./spec/roster-rules.ts";
import { type Platform, type Roster, type ScopeRow, scopeFor } from "./spec/scope.ts";
import { scopedId, scopedIdText, shortId } from "./spec/scoped-id.ts";
import type { CrlNumberStore } from "./storage.ts";
import { bytesOfBigint, equalBytes, wipe } from "./bytes.ts";

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
  /** The choice is not possible: switches used up, nothing to withdraw, or 3 records of the card today. */
  | { code: "blocked"; reason: "switch_limit" | "not_current" | "daily_limit" }
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
  /** The username is not in the scope's format. */
  | { code: "username" }
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
  /** Which roster's scope table the page uses. Fixed by the page, not by a server. */
  roster: Roster;
  /** The issuer keys the page trusts: MOICA_ISSUERS in the page, test keys in tests. */
  issuers: readonly IssuerKey[];
  fetch: Fetch;
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
 *     config         the server answered its CRL age bound
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

/** What the cardholder picks once the card's state is known. */
export type Choice = { action: "declare"; username: string } | { action: "withdraw" };

export interface CardRead {
  /** The name on the certificate, for the screen only. */
  name: string;
  issuer: IssuerKey["name"];
}

export interface CardStatus {
  scopedId: string;
  shortId: string;
  /** What the server says about this card (not checkable by the device). */
  current: string | null;
  lastDeclared: string | null;
  lastCardProof: string | null;
  /**
   * What each choice would be, computed here from those facts and today's
   * date (spec/roster-rules.md); null where the choice does not apply.
   *
   *   refresh      declare the current account again
   *   declareBack  after a withdrawal, declare the last declared account again (not a switch)
   *   other        declare any other account: `first` for a card that never declared,
   *                otherwise `switch`, or blocked by `switch_limit`
   *   withdraw     withdraw the current account
   */
  options: {
    refresh: Outcome | null;
    declareBack: Outcome | null;
    other: Outcome;
    withdraw: Outcome | null;
  };
  /** Switches in the past year (the 365-day window), and how many a declaration today could still make. */
  switchesUsed: number;
  switchesLeft: number;
  /** The first date a switch is allowed (today if it is now). */
  nextSwitchDate: string;
  /**
   * The card has 3 valid records dated today in this scope (`last_card_proof`
   * is today and `proofs_on_last_date` is 3): no choice can be made today,
   * whatever `options` says (spec/roster-rules.md, check 6).
   */
  dailyLimit: boolean;
  today: string;
  /** The roster's size and head the answer was computed at. */
  count: number;
  head: string;
}

/** What a choice would do, for the screen before the second signature. */
export interface Consequence {
  action: Action;
  /** The account the declaration code will name: the typed one, or for a withdrawal the current one. */
  username: string;
  kind: "first" | "refresh" | "switch" | "withdraw";
  /** Switches left in the 365-day window after this card proof. */
  switchesLeftAfter: number;
  /** The first date a switch is allowed after this card proof (today if it is then). */
  nextSwitchDateAfter: string;
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
   * The cards that declare the record's account now (`account_cards`), for
   * which link the screen suggests; null when the record was found in the
   * card's state, or the answer's number could not be read.
   */
  accountCards: number | null;
  kind: "first" | "refresh" | "switch" | "withdraw";
  date: string;
  scopedId: string;
  shortId: string;
  username: string;
  record: Submission;
}

/**
 * Where the flow is. "checking": the card was read and the checks that need
 * no signature are running; the screen does not ask for the PIN yet.
 * "ready_for_pin": they all passed. "status_known": the card signed the
 * scope string and its state is known; the cardholder picks. "chosen": the
 * consequence of the choice is shown; the next step is the second signature.
 * "signing": proceed() is asking for the challenge and the second signature.
 */
export type Phase = "start" | "checking" | "ready_for_pin" | "status_known" | "chosen" | "signing" | "submitting" | "submit_failed" | "done" | "stopped";

interface BackgroundResult {
  tree: AbsenceProof;
  crlNumber: bigint;
  crlDate: Day;
  /** L, the CRL age bound in force (crlMaxAge of the server's figure). */
  maxAgeDays: number;
}

interface Background {
  promise: Promise<BackgroundResult>;
  failed: Stop | null;
  /** Set when every check passed. */
  done: BackgroundResult | null;
}

export class CardProofFlow {
  private readonly deps: FlowDeps;
  private readonly scope: ScopeRow;
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
  private state: CardState | null = null;
  private status: CardStatus | null = null;
  private chosen: Consequence | null = null;
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

  constructor(deps: FlowDeps, opts: { platform: Platform }) {
    this.deps = deps;
    this.scope = scopeFor(deps.roster, opts.platform);
    this.scopeBytes = new TextEncoder().encode(this.scope.scopeString);
    this.idleMs = deps.idleMs ?? IDLE_MS;
  }

  get phase(): Phase {
    return this.phaseValue;
  }

  get scopeString(): string {
    return this.scope.scopeString;
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
    this.submission = null;
    this.status = null;
    this.state = null;
    this.chosen = null;
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
   * the server's CRL age bound, the CRL, the tree and the serial number's
   * absence, the circuit's and the CRS's hashes (the engine's start).
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
        const serverDays = await this.timed("config", requestCrlMaxAge(this.deps.fetch));
        progress("config");
        const maxAgeDays = crlMaxAge(serverDays);
        const crl = await this.timed("crl", loadCrl({ fetch: this.deps.fetch, issuer, today, maxAgeDays, store: this.deps.store }));
        progress("crl");
        builder = await builderP;
        const result = await this.timed("tree_build", builder.build(crl.keys, crl.count, serial));
        if (result.inTree) throw new FlowStop({ code: "revoked" });
        progress("tree");
        await circuitP;
        await this.deps.prover.ready();
        bg.done = { tree: result.proof, crlNumber: crl.crlNumber, crlDate: crl.crlDay, maxAgeDays };
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
      state = await requestCardState(this.deps.fetch, this.scope.scopeString, idText, this.scope.validUsername, this.today());
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    }
    // The wait may have run out while the server answered.
    this.live();
    this.checkIdle();
    const today = this.today();
    this.state = state;
    this.status = {
      scopedId: idText,
      shortId: shortId(idText),
      current: state.current,
      lastDeclared: state.lastDeclared,
      lastCardProof: state.lastCardProof === null ? null : formatDay(state.lastCardProof),
      options: {
        refresh: state.current !== null ? declareOutcome(state, state.current, today) : null,
        declareBack: state.current === null && state.lastDeclared !== null ? declareOutcome(state, state.lastDeclared, today) : null,
        other: declareOutcome(state, otherThan(state.lastDeclared ?? ""), today),
        withdraw: state.current !== null ? withdrawOutcome(state, state.current) : null,
      },
      switchesUsed: switchesInWindow(state, today),
      switchesLeft: switchesLeft(state, today),
      nextSwitchDate: formatDay(nextSwitchDay(state, today)),
      dailyLimit: dailyLimitReached(state, today),
      today: formatDay(today),
      count: state.count,
      head: state.head,
    };
    this.phaseValue = "status_known";
    return this.status;
  }

  /** The card's state from confirmCard(), while the flow waits for a choice or its confirmation; null otherwise. */
  get cardStatus(): CardStatus | null {
    return this.phaseValue === "status_known" || this.phaseValue === "chosen" ? this.status : null;
  }

  // The cardholder picks; nothing is signed or sent ----------------------------

  /**
   * What `choice` would do; the next step is proceed(). A choice that is not
   * possible (switches used up, nothing to withdraw, 3 records today) or an
   * account not in the scope's format throws without ending the flow: the
   * cardholder can pick again. Nothing is signed, nothing is sent.
   */
  choose(choice: Choice): Consequence {
    this.expect("status_known", "chosen");
    this.checkIdle();
    const consequence = this.consequenceOf(choice);
    this.chosen = consequence;
    this.phaseValue = "chosen";
    return consequence;
  }

  /** Back from the consequence to the card's state. Nothing is signed or asked again. */
  back(): CardStatus {
    this.expect("status_known", "chosen");
    this.checkIdle();
    this.chosen = null;
    this.phaseValue = "status_known";
    return this.status!;
  }

  private consequenceOf(choice: Choice): Consequence {
    const state = this.state!;
    const today = this.today();
    let username: string;
    let outcome: Outcome;
    if (choice.action === "declare") {
      if (!this.scope.validUsername(choice.username)) throw new FlowStop({ code: "username" });
      username = choice.username;
      outcome = declareOutcome(state, username, today);
    } else {
      if (state.current === null) throw new FlowStop({ code: "blocked", reason: "not_current" });
      username = state.current;
      outcome = withdrawOutcome(state, username);
    }
    if (outcome.kind === "blocked") throw new FlowStop({ code: "blocked", reason: outcome.reason });
    // Check 6 after the event rules, in the order of the rules.
    if (dailyLimitReached(state, today)) throw new FlowStop({ code: "blocked", reason: "daily_limit" });
    const left = switchesLeft(state, today);
    const after = outcome.kind === "switch" ? { ...state, switchDates: [...state.switchDates, today] } : state;
    return {
      action: choice.action,
      username,
      kind: outcome.kind,
      switchesLeftAfter: outcome.kind === "switch" ? left - 1 : left,
      nextSwitchDateAfter: formatDay(nextSwitchDay(after, today)),
      today: formatDay(today),
    };
  }

  // Step 3: the card signs the declaration code, then prove and submit --------

  /**
   * `confirmedUsername` is the account the consequence showed the cardholder
   * and they confirmed: the typed one, or for a withdrawal the one the server
   * reported as current (Consequence.username). The card signs only if it is
   * the account the declaration code will name.
   */
  async proceed(confirmedUsername: string): Promise<Done> {
    this.expect("chosen");
    this.checkIdle();
    const chosen = this.chosen!;
    if (confirmedUsername !== chosen.username) this.fail({ code: "state" });
    // Again, with today's date: a choice that is no longer possible is not signed.
    let again: Consequence;
    try {
      again = this.consequenceOf(chosen.action === "declare" ? { action: "declare", username: chosen.username } : { action: "withdraw" });
    } catch (e) {
      this.fail(toStop(e));
    }
    if (again.kind !== chosen.kind) this.fail({ code: "state" });
    this.checkBackground();
    // The certificate and the CRL, again with today's date: the card may have
    // been read before midnight. No challenge is asked for if they no longer pass.
    this.checkStillValid(this.today());
    const { action, username } = chosen;
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
    this.progress("challenge");
    const challengeText = challenge as string;
    const code = await declarationCode(action, this.scope.scopeString, username, challengeText);
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
      scope_string: this.scope.scopeString,
      scoped_id: this.status!.scopedId,
      action,
      username,
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
      return this.done(s, { seq: accepted.seq, recordHash: accepted.recordHash, accountCards: accepted.accountCards, kind: accepted.kind });
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

  private done(s: Submission, r: Pick<Done, "seq" | "recordHash" | "accountCards" | "kind">): Done {
    this.phaseValue = "done";
    this.submission = null;
    return { ...r, date: s.challenge.slice(0, 10), scopedId: s.scoped_id, shortId: shortId(s.scoped_id), username: s.username, record: s };
  }

  /**
   * A resubmission was answered `challenge_used`: a record was accepted for
   * this challenge, which no other card proof has. The earlier submission
   * whose answer was lost (no answer in time, a dropped connection) may have
   * reached the server after all. The card's state, asked again, says
   * whether this card proof's record is in the roster: for a declaration,
   * `current` is the account and `last_card_proof` is the record's date; for
   * a withdrawal, `current` is null, `last_declared` is the account and
   * `last_card_proof` is the record's date. Then the card proof is done
   * (without `seq` and `account_cards`); otherwise the flow stops on the
   * server's `challenge_used`. The request carries the scoped ID the
   * submission carried already.
   */
  private async foundInCardState(s: Submission, used: ServerError): Promise<Done> {
    let state: CardStateResponse;
    try {
      state = await requestCardState(this.deps.fetch, s.scope_string, s.scoped_id, this.scope.validUsername, this.today());
    } catch (e) {
      this.live();
      this.fail(toStop(e));
    }
    this.live();
    const recordDay = parseDay(s.challenge.slice(0, 10));
    const found =
      s.action === "declare"
        ? state.current === s.username && state.lastCardProof === recordDay
        : state.current === null && state.lastDeclared === s.username && state.lastCardProof === recordDay;
    if (!found) this.fail(toStop(used));
    return this.done(s, { seq: null, recordHash: null, accountCards: null, kind: this.chosen!.kind });
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

/** An account other than `u` in every scope's format: what declaring "another account" would be does not depend on which one. */
function otherThan(u: string): string {
  return u === "a" ? "b" : "a";
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
