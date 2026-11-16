// One card proof, as a state machine without a screen. The steps follow the
// table in the design notes (three clicks):
//
//   readCard()       read certificates (no PIN); check them; start the
//                    checks that need no signature: CRL, tree, circuit, CRS
//   checksDone()     resolves when every one of those passed; until then
//                    the screen shows no PIN field (`phase` is "checking")
//   confirmCard(pin) card signs the scope string; scoped ID; card state;
//                    what this card proof would do
//   proceed(account) the caller confirms the account it showed; challenge,
//                    checked; card signs the declaration code; PIN dropped;
//                    prove; submit
//   resubmit()       after a network failure, the same record again
//   cancel()         drop everything
//
// The card is asked for its first signature only after every check that
// needs no signature has passed: the certificate, the CRL (downloaded and
// verified), the tree, the serial number not in it, the circuit and CRS
// hashes. A card that fails one of them stops before any request carries
// its scoped ID; otherwise the server would see a scoped ID that asked for
// its state and then went silent, and could match that with the CRL its
// mirror served (ADR-0015, ADR-0016).
//
// Where each value comes from and goes to:
//   scope string     the table in spec/scope.ts, by the platform picked on
//                    the screen; never from a server
//   current_time     the device's clock, as a Taiwan date; a challenge
//                    dated otherwise stops the flow
//   certificate,     from the card; stay in this object; dropped (bytes
//   signatures       zeroed) after the submission is accepted or on cancel
//   PIN              from the caller; kept in memory until the second
//                    signature is made or the flow stops; never stored
//   failures         returned to the caller only; no request carries them
import { type Fetch, ServerError, type Submission, requestCardState, requestChallenge, requestCrlMaxAge, submitRecord } from "./api.ts";
import { type Card, CardError, type CardErrorCode } from "./card/card.ts";
import { type CardCertificate, type CertificateProblem, cardKey, selectCertificate } from "./certificate.ts";
import type { TreeBuilder } from "./crl/build.ts";
import { type RevocationProblem, RevocationError, crlMaxAge, loadCrl } from "./crl/revocation.ts";
import type { AbsenceProof } from "./crl/tree.ts";
import { type IssuerKey, rsaVerify } from "./issuers.ts";
import { ArtifactError, CIRCUITS } from "./prover/artifacts.ts";
import { circuitInputs, circuitOf, expectedPublicInputs } from "./prover/inputs.ts";
import type { Prover, ThreadMode } from "./prover/prover.ts";
import { PROOF_BYTES } from "./prover/prover.ts";
import { parseChallenge, currentTime } from "./spec/challenge.ts";
import { type Day, formatDay, taiwanDay } from "./spec/date.ts";
import { type Action, declarationCode } from "./spec/declaration-code.ts";
import { type Outcome, declareOutcome, nextSwitchDay, switchesLeft, withdrawOutcome } from "./spec/roster-rules.ts";
import { type Platform, type Roster, type ScopeRow, scopeFor } from "./spec/scope.ts";
import { scopedId, scopedIdText, shortId } from "./spec/scoped-id.ts";
import type { CrlNumberStore } from "./storage.ts";
import { bytesOfBigint, wipe } from "./bytes.ts";

/** Why the flow stopped. Returned to the caller; never sent to the server (ADR-0016). */
export type Stop =
  | { code: "card"; card: CardErrorCode }
  | { code: "certificate"; problem: CertificateProblem; notAfter?: string }
  | { code: "revocation"; problem: RevocationProblem }
  /** The card's certificate is on the CRL (revoked or suspended). */
  | { code: "revoked" }
  /** The card returned a signature that does not verify under its certificate's key. */
  | { code: "card_signature" }
  /** The challenge is not in its one spelling. */
  | { code: "challenge_malformed" }
  /** The challenge is not dated today (Taiwan, by the device's clock). */
  | { code: "challenge_not_today"; challengeDate: string; today: string }
  /** The declaration is not possible: switches used up, or nothing to withdraw. */
  | { code: "blocked"; reason: "switch_limit" | "not_current" }
  /** A circuit or CRS file did not match its SHA-256, or could not be fetched. */
  | { code: "artifact"; path: string }
  /** The proof engine could not start or prove. */
  | { code: "engine"; detail: string }
  /** The proof is not 14,656 bytes, or its public inputs are not the ones the device built. */
  | { code: "proof_check" }
  /** The server answered with an error, or a response the device cannot read. */
  | { code: "server"; server: string; status: number }
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
}

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
  /** What this card proof would be, computed here from those facts and today's date. */
  outcome: Outcome;
  /** For `declare`: switches left before this card proof, and after it if it is a switch. */
  switchesLeft: number;
  switchesLeftAfter: number;
  /** The first date a switch is allowed (today if it is now). */
  nextSwitchDate: string;
  /** The account this card proof names: the typed one, or for a withdrawal the current one. */
  username: string | null;
  today: string;
  /** The roster's size and head the answer was computed at. */
  count: number;
  head: string;
}

export interface Done {
  seq: number;
  recordHash: string;
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
 * "ready_for_pin": they all passed.
 */
export type Phase = "start" | "checking" | "ready_for_pin" | "status_known" | "submitting" | "submit_failed" | "done" | "stopped";

interface Background {
  promise: Promise<{ tree: AbsenceProof; crlNumber: bigint; crlDate: Day }>;
  failed: Stop | null;
}

export class CardProofFlow {
  private readonly deps: FlowDeps;
  private readonly action: Action;
  private readonly scope: ScopeRow;
  private readonly scopeBytes: Uint8Array;
  private typedUsername: string | null;

  private phaseValue: Phase = "start";
  private stopped: Stop | null = null;
  private cert: CardCertificate | null = null;
  private cardPublicKey: CryptoKey | null = null;
  private background: Background | null = null;
  private pin: string | null = null;
  private scopeSignature: Uint8Array | null = null;
  private codeSignature: Uint8Array | null = null;
  private status: CardStatus | null = null;
  private scopedIdValue: bigint | null = null;
  private submission: Submission | null = null;

  constructor(deps: FlowDeps, opts: { action: Action; platform: Platform; username?: string }) {
    this.deps = deps;
    this.action = opts.action;
    this.scope = scopeFor(deps.roster, opts.platform);
    this.scopeBytes = new TextEncoder().encode(this.scope.scopeString);
    this.typedUsername = opts.username ?? null;
    if (opts.action === "declare" && (this.typedUsername === null || !this.scope.validUsername(this.typedUsername))) {
      // Every later step throws this stop.
      this.stopped = { code: "username" };
      this.phaseValue = "stopped";
    }
  }

  get phase(): Phase {
    return this.phaseValue;
  }

  get scopeString(): string {
    return this.scope.scopeString;
  }

  /**
   * The reason the flow stopped for good, if it did. A FlowStop thrown while
   * this is null (a wrong PIN, a submission that did not get through) leaves
   * the step to be tried again.
   */
  get stop(): Stop | null {
    return this.stopped;
  }

  private today(): Day {
    return taiwanDay(this.deps.clock());
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
    if (!this.stopped) this.stopped = stop;
    this.phaseValue = "stopped";
    this.dropSecrets();
    throw new FlowStop(this.stopped);
  }

  private expect(...phases: Phase[]): void {
    if (this.stopped) throw new FlowStop(this.stopped);
    if (!phases.includes(this.phaseValue)) throw new FlowStop({ code: "state" });
  }

  private dropSecrets(): void {
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
    if (!this.stopped) this.stopped = { code: "state" };
    this.phaseValue = "stopped";
  }

  private async cardCall<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof CardError) this.fail({ code: "card", card: e.code });
      this.fail({ code: "card", card: "card_error" });
    }
  }

  // Step 1: read the certificates (no PIN) ------------------------------------

  async readCard(): Promise<CardRead> {
    this.expect("start");
    const ders = await this.cardCall(() => this.deps.card.readCertificates());
    const today = this.today();
    const sel = await selectCertificate(ders, today, this.deps.issuers);
    if (!sel.ok) {
      const notAfter = sel.notAfter !== undefined ? formatNotAfter(sel.notAfter) : undefined;
      this.fail({ code: "certificate", problem: sel.problem, ...(notAfter && { notAfter }) });
    }
    this.cert = sel.cert;
    this.cardPublicKey = await cardKey(sel.cert);
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
    const bg: Background = { failed: null, promise: Promise.resolve() as never };
    const circuit = circuitOf(cert);
    const serial = cert.serial;
    const issuer = cert.issuer;
    const run = async () => {
      const builderP = this.timed("tree_workers", this.deps.startTreeBuilder());
      const circuitP = this.deps.prover.preloadCircuit(circuit);
      circuitP.catch(() => undefined); // awaited below; a failure is reported there
      builderP.catch(() => undefined);
      let builder: TreeBuilder | null = null;
      try {
        const serverDays = await this.timed("config", requestCrlMaxAge(this.deps.fetch));
        const crl = await this.timed(
          "crl",
          loadCrl({ fetch: this.deps.fetch, issuer, today, maxAgeDays: crlMaxAge(serverDays), store: this.deps.store }),
        );
        builder = await builderP;
        const result = await this.timed("tree_build", builder.build(crl.keys, crl.count, serial));
        if (result.inTree) throw new FlowStop({ code: "revoked" });
        await circuitP;
        await this.deps.prover.ready();
        return { tree: result.proof, crlNumber: crl.crlNumber, crlDate: crl.crlDay };
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
      this.fail(toStop(e));
    }
  }

  // Step 2: the card signs the scope string -----------------------------------

  async confirmCard(pin: string): Promise<CardStatus> {
    this.expect("checking", "ready_for_pin");
    // Nothing is signed, and no request carries the scoped ID, before these pass.
    await this.checksDone();
    let sig: Uint8Array;
    try {
      sig = await this.deps.card.sign(this.scopeBytes, pin);
    } catch (e) {
      // A wrong PIN does not end the flow: the screen asks again. Nothing is kept.
      if (e instanceof CardError && e.code === "pin_incorrect") throw new FlowStop({ code: "card", card: "pin_incorrect" });
      this.fail({ code: "card", card: e instanceof CardError ? e.code : "card_error" });
    }
    this.pin = pin;
    if (!(await rsaVerify(this.cardPublicKey!, 2048, sig, this.scopeBytes))) {
      wipe(sig);
      this.fail({ code: "card_signature" });
    }
    this.scopeSignature = sig;
    const id = await scopedId(sig, (a, b) => this.deps.prover.hash2(a, b));
    this.scopedIdValue = id;
    const idText = scopedIdText(id);
    let state;
    try {
      state = await requestCardState(this.deps.fetch, this.scope.scopeString, idText, this.scope.validUsername);
    } catch (e) {
      this.fail(toStop(e));
    }
    const today = this.today();
    const username = this.action === "declare" ? this.typedUsername : state.current;
    const outcome =
      this.action === "declare" ? declareOutcome(state, this.typedUsername!, today) : withdrawOutcome(state, state.current ?? "");
    const left = switchesLeft(state, today);
    this.status = {
      scopedId: idText,
      shortId: shortId(idText),
      current: state.current,
      lastDeclared: state.lastDeclared,
      lastCardProof: state.lastCardProof === null ? null : formatDay(state.lastCardProof),
      outcome,
      switchesLeft: left,
      switchesLeftAfter: outcome.kind === "switch" ? left - 1 : left,
      nextSwitchDate: formatDay(nextSwitchDay(state, today)),
      username,
      today: formatDay(today),
      count: state.count,
      head: state.head,
    };
    this.phaseValue = "status_known";
    return this.status;
  }

  // Step 3: the card signs the declaration code, then prove and submit --------

  /**
   * `confirmedUsername` is the account the screen showed the cardholder and
   * they confirmed: the typed one, or for a withdrawal the one the server
   * reported as current (CardStatus.username). The card signs only if it is
   * the account the declaration code will name.
   */
  async proceed(confirmedUsername: string): Promise<Done> {
    this.expect("status_known");
    const status = this.status!;
    if (status.outcome.kind === "blocked") this.fail({ code: "blocked", reason: status.outcome.reason });
    if (status.username === null || confirmedUsername !== status.username) this.fail({ code: "state" });
    this.checkBackground();
    const username = status.username;

    let challenge: unknown;
    try {
      challenge = await requestChallenge(this.deps.fetch);
    } catch (e) {
      this.fail(toStop(e));
    }
    const challengeDay = parseChallenge(challenge);
    if (challengeDay === null) this.fail({ code: "challenge_malformed" });
    const today = this.today();
    if (challengeDay !== today) {
      this.fail({ code: "challenge_not_today", challengeDate: formatDay(challengeDay), today: formatDay(today) });
    }
    const challengeText = challenge as string;
    const code = await declarationCode(this.action, this.scope.scopeString, username, challengeText);

    const pin = this.pin!;
    let sig: Uint8Array;
    try {
      sig = await this.cardCall(() => this.deps.card.sign(code, pin));
    } finally {
      this.pin = null; // the second signature is made (or failed): the PIN is not needed again
    }
    if (!(await rsaVerify(this.cardPublicKey!, 2048, sig, code))) {
      wipe(sig);
      this.fail({ code: "card_signature" });
    }
    this.codeSignature = sig;

    let bg;
    try {
      bg = await this.background!.promise;
    } catch (e) {
      this.fail(toStop(e));
    }
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
      this.fail(toStop(e));
    }
    const expected = expectedPublicInputs(cert, bg.tree.root, ct, this.scopedIdValue!, this.scopeBytes, code);
    if (
      proof.proof.length !== PROOF_BYTES ||
      proof.publicInputs.length !== CIRCUITS[circuit].publicInputs ||
      proof.publicInputs.length !== expected.length ||
      proof.publicInputs.some((x, i) => x !== expected[i])
    ) {
      this.fail({ code: "proof_check" });
    }
    this.submission = {
      scope_string: this.scope.scopeString,
      scoped_id: status.scopedId,
      action: this.action,
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
      this.phaseValue = "done";
      this.submission = null;
      return {
        seq: accepted.seq,
        recordHash: accepted.recordHash,
        kind: accepted.kind,
        date: s.challenge.slice(0, 10),
        scopedId: s.scoped_id,
        shortId: shortId(s.scoped_id),
        username: s.username,
        record: s,
      };
    } catch (e) {
      // Transient: no answer, rate limited, or a server failure. `crl_stale`
      // (503) is the server refusing every card proof until MOICA's CRL is
      // fresh again: not something a resubmission fixes.
      if (e instanceof ServerError && (e.code === "network" || e.status === 429 || (e.status >= 500 && e.code !== "crl_stale"))) {
        // The record can be sent again as it is (up to 5 submissions per challenge).
        this.phaseValue = "submit_failed";
        throw new FlowStop({ code: "server", server: e.code, status: e.status });
      }
      this.fail(toStop(e));
    }
  }

  /** Sends the same record again after a network failure. No new signature. */
  async resubmit(): Promise<Done> {
    this.expect("submit_failed");
    this.phaseValue = "submitting";
    return this.submit();
  }

  /** How the engine runs, for the screen's time estimate. */
  async threadMode(): Promise<ThreadMode> {
    return this.deps.prover.ready();
  }
}

function toStop(e: unknown): Stop {
  if (e instanceof FlowStop) return e.stop;
  if (e instanceof RevocationError) return { code: "revocation", problem: e.problem };
  if (e instanceof ArtifactError) return { code: "artifact", path: e.path };
  if (e instanceof ServerError) return { code: "server", server: e.code, status: e.status };
  if (e instanceof CardError) return { code: "card", card: e.code };
  return { code: "engine", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
}

/** notAfter YYMMDDHHMMSS (UTC) as the Taiwan date the certificate expires on. */
function formatNotAfter(t: bigint): string {
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
