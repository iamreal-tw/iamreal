// The screens of a card proof (design/copy/card-proof.md, sections 1 to 6):
// first the card is confirmed, then the cardholder picks what to do, then
// the declaration is made. Three clicks open the component's window: read
// the card, confirm the card (first signature), the last button of the
// consequence (second signature). On top of the engine (src/flow.ts). The
// screen holds no value longer than it shows it:
//
//   - The PIN is read from its field when "confirm" is clicked, the field is
//     emptied at once, and the value goes to the engine and nowhere else (no
//     storage, URL, log, global or DOM attribute). The field is not in a form
//     and has no name, so the browser has nothing to remember it by. The
//     engine holds it until the second signature, and drops it if that is
//     not made within 5 minutes of the first (the screen goes back to the
//     beginning).
//   - The name on the certificate is shown in section 2 only; that screen is
//     taken down when the card's state is known.
//   - A typed account is kept in this module's memory while its screens are
//     up (to fill the field again after going back); it is not stored.
//
// A window the browser blocks sends nothing: the screen says so, and the same
// button can be pressed again once the cardholder allowed the windows.
//
// Every sentence comes from copy.ts; ids and data-* attributes are for the
// headless browser test and hold no value.
import type { Card, CardSignature } from "../card/card.ts";
import {
  type CardProofFlow,
  type CardStatus,
  type Choice,
  type Consequence,
  type Done,
  FlowStop,
  type Prover,
  type Stop,
  ROSTER,
  createCardProof,
  normalizeUsername,
} from "../index.ts";
import { scopeFor } from "../spec/scope.ts";
import { COPY, fill } from "./copy.ts";
import { append, button, el, replace, sentence } from "./dom.ts";
import { type Message, PLATFORM_NAMES, type Sentence, consequenceView, doneRecord, doneTitle, statusView, stopMessage } from "./messages.ts";

/** A card whose component window the screen opens in the click handler (hipki.ts). */
export interface WindowedCard extends Card {
  /** Opens the window for the next request; false if the browser blocked it. */
  open(): boolean;
  release(): void;
}

export interface AppOptions {
  root: HTMLElement;
  prover: Prover;
  card: WindowedCard;
  /** Step timings, for measurements (they stay on the page). */
  onTiming?: (step: string, ms: number) => void;
}

const PLATFORM = "threads" as const;
const platformName = PLATFORM_NAMES[PLATFORM];

type HelpTopic = keyof typeof COPY.links;

function helpLink(topic: HelpTopic): HTMLAnchorElement {
  // A new tab: leaving this page would end the card proof.
  return el("a", { attrs: { href: `/help.html?topic=${topic}`, target: "_blank", rel: "noopener noreferrer", "data-help": topic } }, COPY.links[topic]);
}

function say(s: Sentence): DocumentFragment {
  return sentence(s.template, s.values);
}

/** A message element: the sentence (or the code alone), the request ID, the help link. */
function messageNodes(m: Message): Node[] {
  const out: Node[] = [];
  if ("code" in m) out.push(el("code", { attrs: { "data-code": "" } }, m.code));
  else out.push(say(m));
  if ("link" in m && m.link) out.push(document.createTextNode(" "), helpLink(m.link));
  if (m.requestId) out.push(document.createTextNode(" "), el("code", { class: "request-id", attrs: { "data-request-id": "" } }, m.requestId));
  return out;
}

function stopOf(e: unknown): Stop {
  return e instanceof FlowStop ? e.stop : { code: "engine", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
}

/** The message area of a screen. */
function messageArea(): { node: HTMLElement; show: (m: Message | null) => void } {
  const node = el("p", { class: "message", attrs: { role: "alert", "data-message": "" } });
  return { node, show: (m) => (m ? replace(node, ...messageNodes(m)) : replace(node)) };
}

const BLOCKED: Message = stopMessage({ code: "card", card: "popup_blocked" });

/** Passes the card through, and tells the screen when a signature is made. */
class WatchedCard implements Card {
  private readonly inner: WindowedCard;
  onSigned: (() => void) | null = null;
  constructor(inner: WindowedCard) {
    this.inner = inner;
  }
  readCertificates(): Promise<Uint8Array[]> {
    return this.inner.readCertificates();
  }
  async sign(message: Uint8Array, pin: string): Promise<CardSignature> {
    const r = await this.inner.sign(message, pin);
    this.onSigned?.();
    return r;
  }
}

export function startApp(o: AppOptions): void {
  const root = o.root;
  const card = o.card;
  const watched = new WatchedCard(card);
  const validUsername = scopeFor(ROSTER, PLATFORM).validUsername;
  let flow: CardProofFlow | null = null;
  /** Section 5 listens for the end of the proof. */
  let onStep: ((step: string) => void) | null = null;
  const timing = (step: string, ms: number): void => {
    o.onTiming?.(step, ms);
    onStep?.(step);
  };

  document.title = fill(COPY.before_pin.title, { platform: platformName });

  const drop = (): void => {
    flow?.cancel();
    flow = null;
    card.release();
  };

  /** A FlowStop that leaves the step to be tried again (the flow did not end). */
  const retryable = (f: CardProofFlow, e: unknown): e is FlowStop => e instanceof FlowStop && f.stop === null;

  // Sections 1 and 2: before the PIN; reading the card; the PIN ----------------------

  /** The beginning. `why`: the reason the screen came back here (the wait for the second signature ran out). */
  function start(why: Message | null = null): void {
    drop();
    const c = COPY.before_pin;
    const cc = COPY.confirm_card;
    const step = el("div", { class: "card-step", attrs: { "data-card-step": "" } });
    const message = messageArea();

    const stopped = (e: unknown): void => {
      card.release();
      message.show(stopMessage(stopOf(e)));
      readButton(); // another try starts a new card proof (reading needs no PIN)
    };

    const readButton = (): void => replace(step, button(c.read_card, onRead, "primary"));

    function onRead(ev: MouseEvent): void {
      // The component's window opens now, in the click (one click, one window).
      if (!card.open()) {
        // Nothing was sent. The same button, once the browser allows the window.
        message.show(BLOCKED);
        return;
      }
      (ev.currentTarget as HTMLButtonElement).disabled = true;
      message.show(null);
      flow?.cancel();
      const f = createCardProof({
        platform: PLATFORM,
        card: watched,
        prover: o.prover,
        onTiming: timing,
        onIdle: (stop) => flow === f && start(stopMessage(stop)),
      });
      flow = f;
      f.readCard().then(
        (read) => {
          if (flow !== f) return;
          const name = el("div", { attrs: { "data-card-read": "" } }, el("p", {}, sentence(cc.card_read, { name: read.name })), el("p", {}, cc.name_note));
          replace(step, name);
          // The PIN field appears only when every check that needs no signature passed.
          f.checksDone().then(
            () => flow === f && pinField(f, name),
            (e) => flow === f && stopped(e),
          );
        },
        (e) => {
          if (flow !== f) return;
          stopped(e);
        },
      );
    }

    function pinField(f: CardProofFlow, name: HTMLElement): void {
      const pin = el("input", {
        attrs: { id: "pin", type: "password", autocomplete: "off", inputmode: "numeric", autocapitalize: "off", spellcheck: "false" },
      });
      const confirm = button(cc.confirm_card, onConfirm, "primary");
      confirm.disabled = true;
      pin.addEventListener("input", () => (confirm.disabled = pin.value === ""));
      replace(
        step,
        name,
        el("p", { class: "pin" }, el("label", { attrs: { for: "pin" } }, cc.pin_label), " ", pin),
        el("p", {}, confirm),
        el("p", {}, cc.confirm_note),
      );
      pin.focus();

      function onConfirm(): void {
        // Read once, then the field is empty; the value goes to the engine only.
        const value = pin.value;
        pin.value = "";
        confirm.disabled = true;
        if (value === "") return; // never sent without a PIN
        if (!card.open()) {
          // Nothing was sent, and the PIN went nowhere: typed again, pressed again.
          message.show(BLOCKED);
          pin.focus();
          return;
        }
        message.show(null);
        f.confirmCard(value).then(
          (status) => flow === f && statusScreen(f, status),
          (e) => {
            if (flow !== f) return;
            card.release();
            // A wrong PIN or a blocked window leaves the step to be tried again; nothing is resent by itself.
            if (retryable(f, e)) {
              message.show(stopMessage(e.stop));
              pin.focus();
              return;
            }
            stopped(e);
          },
        );
      }
    }

    const list = (...items: string[]) => el("ul", {}, ...items.map((i) => el("li", {}, i)));
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "before_pin" } },
        el("h1", {}, sentence(c.title, { platform: platformName })),
        el("dl", { class: "fields" }, el("dt", {}, c.platform_label), el("dd", {}, sentence(c.platform, { platform: platformName }))),
        el("p", {}, c.insert, el("br"), c.pin_purpose, el("br"), c.nothing_public),
        el("section", {}, el("h2", {}, c.local_heading), list(c.local_pin, c.local_certificate, c.local_signature)),
        el("p", {}, c.keep_card, el("br"), c.card_and_pin, " ", helpLink("more")),
        step,
        message.node,
        el("p", {}, c.needs, " ", helpLink("prepare")),
      ),
    );
    if (why) message.show(why);
    readButton();
  }

  // Section 3: the card's state and what can be done ----------------------------------

  /** The account field of section 3: status.account_label (a card that never declared) or status.new_account_label. */
  function accountField(label: string, typed: string, next: (u: string) => void, show: (m: Message | null) => void): { field: HTMLElement; go: () => void } {
    const c = COPY.status;
    const input = el("input", { attrs: { id: "account", type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false" } });
    input.value = typed;
    const go = (): void => {
      const u = normalizeUsername(input.value);
      if (!validUsername(u)) {
        show(stopMessage({ code: "username" }));
        return;
      }
      next(u);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") go();
    });
    queueMicrotask(() => input.focus());
    const field = el(
      "dl",
      { class: "fields" },
      el("dt", {}, el("label", { attrs: { for: "account" } }, label)),
      el("dd", {}, el("span", { class: "prefix" }, c.account_prefix), input),
    );
    return { field, go };
  }

  const noCheck = (): HTMLElement => el("p", {}, COPY.status.no_check, el("br"), COPY.status.acknowledged, " ", helpLink("more"));

  /**
   * Picks `choice` in the engine and shows its consequence. A choice the
   * engine refuses (an account not in the format, a switch when none is
   * left) stays on this screen with the message.
   */
  function pick(f: CardProofFlow, choice: Choice, show: (m: Message | null) => void, back: () => void): void {
    let cq: Consequence;
    try {
      cq = f.choose(choice);
    } catch (e) {
      if (flow !== f) return; // the wait ran out: the beginning is on screen already
      if (retryable(f, e)) return show(stopMessage(e.stop));
      return start(stopMessage(stopOf(e)));
    }
    consequenceScreen(f, cq, back);
  }

  /** Back from the consequence: the engine first, then the screen the choice was made on. */
  function goBack(f: CardProofFlow, to: (status: CardStatus) => void): void {
    let status: CardStatus;
    try {
      status = f.back();
    } catch (e) {
      if (flow === f) start(stopMessage(stopOf(e)));
      return;
    }
    to(status);
  }

  function statusScreen(f: CardProofFlow, status: CardStatus, typed = ""): void {
    // Section 2, with the name, is taken down here.
    const c = COPY.status;
    const view = statusView(status, PLATFORM);
    const message = messageArea();
    const first = el("p", { attrs: { "data-status": "" } }, say(view.first));
    const choice = (label: string | DocumentFragment, note: string | DocumentFragment | null, onClick: () => void, enabled = true): HTMLElement => {
      const b = button(label, onClick, "");
      b.disabled = !enabled;
      return el("p", { class: "choice", attrs: { "data-choice": "" } }, b, note && el("span", { class: "note" }, note));
    };
    const switchNote = (): string | DocumentFragment => (view.switchLimit ? say(view.switchLimit) : c.uses_switch);
    let body: (HTMLElement | null)[];
    if (view.state === "never") {
      const account = accountField(c.account_label, typed, (u) => pick(f, { action: "declare", username: u }, message.show, () => goBack(f, (st) => statusScreen(f, st, u))), message.show);
      body = [account.field, el("p", {}, sentence(c.one_account, { platform: platformName })), message.node, el("p", {}, button(c.next, account.go, "primary")), noCheck()];
    } else if (view.state === "declared") {
      const current = status.current!;
      const again = (): void => goBack(f, (st) => statusScreen(f, st));
      body = [
        // One line, as in the copy.
        el("p", {}, ...view.facts.map((m) => el("span", { attrs: { "data-fact": "" } }, ...messageNodes(m)))),
        choice(c.refresh, c.refresh_note, () => pick(f, { action: "declare", username: current }, message.show, again)),
        choice(c.switch, switchNote(), () => accountScreen(f, status, ""), view.canSwitch),
        choice(c.withdraw, null, () => pick(f, { action: "withdraw" }, message.show, again)),
        message.node,
      ];
    } else {
      const last = status.lastDeclared!;
      body = [
        choice(sentence(c.declare_back, { last_declared: last }), c.not_a_switch, () =>
          pick(f, { action: "declare", username: last }, message.show, () => goBack(f, (st) => statusScreen(f, st))),
        ),
        choice(c.declare_other, switchNote(), () => accountScreen(f, status, ""), view.canSwitch),
        message.node,
      ];
    }
    replace(root, el("section", { attrs: { "data-step": "status", "data-state": view.state } }, first, ...body));
  }

  /** After status.switch or status.declare_other: the new account. */
  function accountScreen(f: CardProofFlow, status: CardStatus, typed: string): void {
    const c = COPY.status;
    const message = messageArea();
    const account = accountField(c.new_account_label, typed, (u) => pick(f, { action: "declare", username: u }, message.show, () => goBack(f, (st) => accountScreen(f, st, u))), message.show);
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "account" } },
        account.field,
        message.node,
        el("p", { class: "buttons" }, button(c.back, () => statusScreen(f, status), ""), " ", button(c.next, account.go, "primary")),
        noCheck(),
      ),
    );
  }

  // Section 4: the consequence ---------------------------------------------------------

  function consequenceScreen(f: CardProofFlow, cq: Consequence, back: () => void, why: Message | null = null): void {
    const c = COPY.consequence;
    const view = consequenceView(cq, f.cardStatus?.current ?? null, PLATFORM);
    const message = messageArea();
    const go = button(say(view.button), () => {
      // The component's window for the second signature opens now, in the click.
      if (!card.open()) {
        // Nothing was sent; the PIN stays where it was (the engine, until the wait runs out).
        message.show(BLOCKED);
        return;
      }
      progress(f, cq, back);
    }, "primary");
    const later: (string | HTMLElement)[] = [];
    for (const [i, line] of view.later.entries()) later.push(...(i ? [el("br"), line] : [line]));
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "consequence" } },
        el("p", { attrs: { "data-consequence": "" } }, c.record_intro, el("br"), el("span", { attrs: { "data-record-line": "" } }, say(view.record)), el("br"), c.with_id),
        view.switchLine && el("p", { attrs: { "data-switch-line": "" } }, say(view.switchLine)),
        el("p", {}, c.no_identity, el("br"), c.card_and_pin),
        el("p", {}, ...later),
        message.node,
        el("p", { class: "buttons" }, button(c.back, back, ""), " ", go),
      ),
    );
    if (why) message.show(why);
  }

  // Section 5: in progress ---------------------------------------------------------

  function progress(f: CardProofFlow, cq: Consequence, back: () => void): void {
    const c = COPY.progress;
    const lines = el("div", { attrs: { "data-progress": "" } });
    const message = messageArea();
    const bar = el("progress", { attrs: { max: "100", value: "0" } });
    let timer: ReturnType<typeof setInterval> | undefined;
    replace(root, el("section", { attrs: { "data-step": "progress" } }, lines, message.node));
    append(lines, el("p", {}, c.signing));

    watched.onSigned = () => {
      watched.onSigned = null;
      append(lines, el("p", {}, c.computing), el("p", {}, bar));
      // The bar fills over the time a proof takes here: a few seconds with
      // several threads, about 10 with one (web/README.md, "Times").
      const t0 = performance.now();
      o.prover.ready().then((mode) => {
        const expected = mode.multithreaded ? 5_000 : 15_000;
        bar.dataset.threads = String(mode.threads);
        timer = setInterval(() => (bar.value = Math.min(95, ((performance.now() - t0) / expected) * 100)), 200);
      }, () => undefined);
    };
    onStep = (step) => {
      if (step === "proof") {
        clearInterval(timer);
        bar.value = 100;
        append(lines, el("p", {}, c.submitting));
      }
    };

    const finish = (p: Promise<Done>): void => {
      p.then(
        (done) => {
          onStep = null;
          if (flow === f) doneScreen(done);
        },
        (e) => {
          clearInterval(timer);
          watched.onSigned = null;
          card.release();
          if (flow !== f) return;
          // A blocked window: nothing reached the card; back to the consequence, the same button again.
          if (retryable(f, e) && e.stop.code === "card" && e.stop.card === "popup_blocked") {
            consequenceScreen(f, cq, back, BLOCKED);
            return;
          }
          const m = stopMessage(stopOf(e), f.phase === "submit_failed");
          message.show(m);
          if (!("code" in m) && m.retry) {
            append(message.node, " ", button(COPY.stops.retry, () => {
              message.show(null);
              finish(f.resubmit());
            }, "primary"));
          }
        },
      );
    };
    finish(f.proceed(cq.username));
  }

  // Section 6: done -------------------------------------------------------------

  function doneScreen(d: Done): void {
    const c = COPY.done;
    flow = null;
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "done" } },
        el("h1", {}, say(doneTitle(d.kind, d.username))),
        el("p", { attrs: { "data-record": "" } }, sentence(c.seq, { seq: d.seq }), say(doneRecord(d.kind, d.date, d.username, PLATFORM))),
        el("p", {}, sentence(c.short_id, { platform: platformName, short_id: d.shortId })),
        el("ul", {}, d.kind !== "withdraw" && el("li", {}, c.advice), el("li", {}, c.reverify, " ", helpLink("reverify"))),
        el("p", {}, c.unplug),
      ),
    );
  }

  start();
}
