// The five screens of a card proof and the withdrawal (design/copy/card-proof.md),
// three clicks, on top of the engine (src/flow.ts). The screen holds no
// value longer than it shows it:
//
//   - The PIN is read from its field when "confirm" is clicked, the field is
//     emptied at once, and the value goes to the engine and nowhere else (no
//     storage, URL, log, global or DOM attribute). The field is not in a form
//     and has no name, so the browser has nothing to remember it by.
//   - The name on the certificate is shown on screen 2 only; the screen is
//     taken down when the card's state is known.
//   - The account typed on screen 1 is kept in this module's memory while
//     the page is open, to fill the screens; it is not stored.
//
// Every sentence comes from copy.ts; ids and data-* attributes are for the
// headless browser test and hold no value.
import type { Card, CardSignature } from "../card/card.ts";
import { type CardProofFlow, type CardStatus, type Done, FlowStop, type Prover, type Stop, ROSTER, createCardProof, normalizeUsername } from "../index.ts";
import type { Action } from "../spec/declaration-code.ts";
import { scopeFor } from "../spec/scope.ts";
import { COPY, fill } from "./copy.ts";
import { append, button, el, replace, sentence } from "./dom.ts";
import { type Message, PLATFORM_NAMES, type Sentence, doneTitle, statusView, stopMessage } from "./messages.ts";

/** A card whose component window the screen opens in the click handler (hipki.ts). */
export interface WindowedCard extends Card {
  open(): void;
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
  /** Screen 4 listens for the end of the proof. */
  let onStep: ((step: string) => void) | null = null;
  const timing = (step: string, ms: number): void => {
    o.onTiming?.(step, ms);
    onStep?.(step);
  };

  document.title = fill(COPY.enter.title, { platform: platformName });

  const drop = (): void => {
    flow?.cancel();
    flow = null;
    card.release();
  };

  // Screen 1: the account -------------------------------------------------------

  function enter(typed = ""): void {
    drop();
    const c = COPY.enter;
    const input = el("input", {
      attrs: { id: "account", type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false" },
    });
    input.value = typed;
    const message = el("p", { class: "message", attrs: { role: "alert", "data-message": "" } });
    const next = (): void => {
      const u = normalizeUsername(input.value);
      if (!validUsername(u)) {
        replace(message, sentence(c.bad_username));
        return;
      }
      beforePin("declare", u);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") next();
    });
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "enter" } },
        el("h1", {}, sentence(c.title, { platform: platformName })),
        el(
          "dl",
          { class: "fields" },
          el("dt", {}, c.platform_label),
          el("dd", {}, platformName),
          el("dt", {}, el("label", { attrs: { for: "account" } }, c.account_label)),
          el("dd", {}, el("span", { class: "prefix" }, c.account_prefix), input),
        ),
        el("p", {}, sentence(c.one_account, { platform: platformName })),
        message,
        el("p", {}, button(c.next, next, "primary")),
        el("p", {}, c.needs, " ", helpLink("prepare")),
        el("p", {}, c.no_check, el("br"), c.acknowledged, " ", helpLink("more")),
        el("p", {}, c.withdraw_prompt, " ", button(c.withdraw, () => beforePin("withdraw", null), "link")),
      ),
    );
    input.focus();
  }

  // Screen 2: before the PIN; reading the card; the PIN ------------------------------

  function beforePin(action: Action, account: string | null): void {
    drop();
    const c = COPY.before_pin;
    const step = el("div", { class: "card-step", attrs: { "data-card-step": "" } });
    const message = el("p", { class: "message", attrs: { role: "alert", "data-message": "" } });
    const show = (m: Message | null): void => (m ? replace(message, ...messageNodes(m)) : replace(message));

    const stopped = (e: unknown): void => {
      card.release();
      show(stopMessage(stopOf(e)));
      readButton(); // another try starts a new card proof (reading needs no PIN)
    };

    const readButton = (): void => replace(step, button(c.read_card, onRead, "primary"));

    function onRead(ev: MouseEvent): void {
      // The component's window opens now, in the click (one click, one window).
      card.open();
      (ev.currentTarget as HTMLButtonElement).disabled = true;
      show(null);
      flow?.cancel();
      const f = createCardProof({
        action,
        platform: PLATFORM,
        username: account ?? undefined,
        card: watched,
        prover: o.prover,
        onTiming: timing,
      });
      flow = f;
      f.readCard().then((read) => {
        if (flow !== f) return;
        const name = el("div", { attrs: { "data-card-read": "" } }, el("p", {}, sentence(c.card_read, { name: read.name })), el("p", {}, c.name_note));
        replace(step, name);
        // The PIN field appears only when every check that needs no signature passed.
        f.checksDone().then(
          () => flow === f && pinField(f, name),
          (e) => flow === f && stopped(e),
        );
      }, stopped);
    }

    function pinField(f: CardProofFlow, name: HTMLElement): void {
      const pin = el("input", {
        attrs: { id: "pin", type: "password", autocomplete: "off", inputmode: "numeric", autocapitalize: "off", spellcheck: "false" },
      });
      const confirm = button(c.confirm_card, onConfirm, "primary");
      confirm.disabled = true;
      pin.addEventListener("input", () => (confirm.disabled = pin.value === ""));
      replace(
        step,
        name,
        el("p", { class: "pin" }, el("label", { attrs: { for: "pin" } }, c.pin_label), " ", pin),
        el("p", {}, confirm),
        el("p", {}, c.confirm_note),
      );
      pin.focus();

      function onConfirm(): void {
        // Read once, then the field is empty; the value goes to the engine only.
        const value = pin.value;
        pin.value = "";
        confirm.disabled = true;
        if (value === "") return; // never sent without a PIN
        card.open();
        show(null);
        f.confirmCard(value).then(
          (status) => flow === f && cardState(f, action, status),
          (e) => {
            if (flow !== f) return;
            card.release();
            // A wrong PIN leaves the step to be tried again; nothing is resent by itself.
            if (e instanceof FlowStop && f.stop === null && e.stop.code === "card" && e.stop.card === "pin_incorrect") {
              show(stopMessage(e.stop));
              pin.focus();
              return;
            }
            stopped(e);
          },
        );
      }
    }

    const declaring =
      action === "declare"
        ? [el("p", {}, sentence(c.declaring, { platform: platformName })), el("p", { class: "account" }, sentence(c.account, { account: account! })), el("p", {}, c.switches)]
        : [el("p", {}, sentence(c.withdrawing, { platform: platformName }))];
    const list = (...items: (string | DocumentFragment)[]) => el("ul", {}, ...items.map((i) => el("li", {}, i)));
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "before_pin" } },
        el("p", {}, c.insert),
        ...declaring,
        el(
          "div",
          { class: "columns" },
          el(
            "section",
            {},
            el("h2", {}, c.public_heading),
            list(action === "declare" ? sentence(c.public_declare, { platform: platformName, account: account! }) : c.public_withdraw, c.public_id, c.public_date),
          ),
          el("section", {}, el("h2", {}, c.local_heading), list(c.local_pin, c.local_certificate, c.local_signature)),
        ),
        el(
          "p",
          {},
          c.keep_card,
          el("br"),
          action === "declare" ? sentence(c.card_and_pin_declare, { account: account! }) : c.card_and_pin_withdraw,
          " ",
          helpLink("more"),
        ),
        step,
        message,
      ),
    );
    readButton();
  }

  // Screen 3: the card's state and the consequence -----------------------------------

  function cardState(f: CardProofFlow, action: Action, status: CardStatus): void {
    // Screen 2, with the name, is taken down here.
    const c = COPY.status;
    const view = statusView(action, status, PLATFORM);
    const cancel = button(c.cancel, () => enter(action === "declare" ? (status.username ?? "") : ""), "");
    const buttons = el("p", { class: "buttons" }, cancel);
    if (view.button) {
      const go = button(say(view.button), () => {
        // The component's window for the second signature opens now, in the click.
        card.open();
        progress(f, action, status);
      }, "primary");
      append(buttons, " ", go);
    }
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "status" } },
        el("p", { attrs: { "data-status": "" } }, ...messageNodes(view.first)),
        view.record && el("p", {}, c.record_intro, el("br"), say(view.record)),
        el("p", {}, c.no_identity, el("br"), c.card_and_pin),
        el("p", {}, c.later, el("br"), c.permanent),
        buttons,
      ),
    );
  }

  // Screen 4: in progress ---------------------------------------------------------

  function progress(f: CardProofFlow, action: Action, status: CardStatus): void {
    const c = COPY.progress;
    const lines = el("div", { attrs: { "data-progress": "" } });
    const message = el("p", { class: "message", attrs: { role: "alert", "data-message": "" } });
    const bar = el("progress", { attrs: { max: "100", value: "0" } });
    let timer: ReturnType<typeof setInterval> | undefined;
    replace(root, el("section", { attrs: { "data-step": "progress" } }, lines, message));
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
          if (flow === f) doneScreen(action, done);
        },
        (e) => {
          clearInterval(timer);
          watched.onSigned = null;
          card.release();
          if (flow !== f) return;
          const m = stopMessage(stopOf(e), f.phase === "submit_failed");
          replace(message, ...messageNodes(m));
          if (!("code" in m) && m.retry) {
            append(message, " ", button(COPY.stops.retry, () => {
              replace(message);
              finish(f.resubmit());
            }, "primary"));
          }
        },
      );
    };
    finish(f.proceed(status.username!));
  }

  // Screen 5: done -------------------------------------------------------------

  function doneScreen(action: Action, d: Done): void {
    const c = COPY.done;
    const record = sentence(action === "withdraw" ? COPY.status.record_withdraw : COPY.status.record_declare, {
      today: d.date,
      platform: platformName,
      account: d.username,
    });
    flow = null;
    replace(
      root,
      el(
        "section",
        { attrs: { "data-step": "done" } },
        el("h1", {}, say(doneTitle(d.kind, d.username))),
        el("p", { attrs: { "data-record": "" } }, sentence(c.seq, { seq: d.seq }), record),
        el("p", {}, sentence(c.short_id, { platform: platformName, short_id: d.shortId })),
        el("ul", {}, el("li", {}, c.advice), el("li", {}, c.reverify, " ", helpLink("reverify"))),
        el("p", {}, c.unplug),
      ),
    );
  }

  enter();
}
