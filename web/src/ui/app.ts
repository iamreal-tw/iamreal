// The screens of a card proof (design/copy/card-proof.md): pick the
// platform, then six steps, one screen each: before you start, read the
// card, the PIN, what to do, confirm (and in progress), done. First the card
// is confirmed, then the cardholder picks what to do, then the declaration
// is made. Three clicks open the component's window: read the card, confirm
// the card (first signature), the last button of step 5 (second signature).
// On top of the engine (src/flow.ts). The screen holds no value longer than
// it shows it:
//
//   - The PIN is read from its field when "confirm" is clicked, the field is
//     emptied at once, and the value goes to the engine and nowhere else (no
//     storage, URL, log, global or DOM attribute). The field is not in a form
//     and has no name, so the browser has nothing to remember it by. Until
//     that step ends, the field and the button cannot be used. The engine
//     holds it until the second signature, and drops it if that is not made
//     within 5 minutes of the first, or when "cancel" or "back to the beginning" is pressed
//     (the screen then goes back to step 1 or to the platforms).
//   - The name on the certificate is shown on step 3 only; the screen keeps
//     it while step 3 is up.
//   - A typed account is kept in this module's memory while its screens are
//     up (to fill the field again after going back); it is not stored.
//
// A window the browser blocks sends nothing: the screen says so, and the same
// button can be pressed again once the cardholder allowed the windows.
//
// "Preview the profile" (choose.preview) opens the account's page on the platform in a new tab
// (window.open with noopener and noreferrer): the only place this page sends
// the cardholder elsewhere. The new tab gets the account typed and nothing
// else; this page loads nothing from the platform.
//
// Every sentence comes from copy.ts, every platform's name, prefix, format
// and address from src/platforms.ts; ids and data-* attributes are for the
// headless browser test and hold no value.
import { type CardProofFlow, type CardStatus, type Choice, type Consequence, type Done, FlowStop, type OpenPlatform, PLATFORMS, type Progress, type Prover, type Stop, createCardProof, handle } from "../index.ts";
import type { Card } from "../card/card.ts";
import { COPY, fill, parts } from "./copy.ts";
import { button, el, replace, sentence } from "./dom.ts";
import { logo } from "./logo.ts";
import {
  type HelpTopic,
  type ItemState,
  type ListItem,
  type Message,
  PROGRESS_ITEMS,
  READ_ITEMS,
  type Sentence,
  consequenceView,
  doneView,
  firstNotDone,
  formatHint,
  itemStates,
  progressButtons,
  readItemOf,
  statusView,
  stopMessage,
} from "./messages.ts";

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

/** The six steps after the platform (card-proof.md). */
const STEPS = 6;

function helpLink(topic: HelpTopic): HTMLAnchorElement {
  // A new tab: leaving this page would end the card proof.
  return el("a", { attrs: { href: `/help.html?topic=${topic}`, target: "_blank", rel: "noopener noreferrer", "data-help": topic } }, COPY.links[topic]);
}

function say(s: Sentence): DocumentFragment {
  return sentence(s.template, s.values);
}

/** A message: the sentence (or the code alone), the help link, the request ID on a line of its own. */
function messageNodes(m: Message): Node[] {
  const out: Node[] = [];
  if ("code" in m) out.push(el("code", { attrs: { "data-code": "" } }, m.code));
  else out.push(say(m));
  if ("link" in m && m.link) out.push(document.createTextNode(" "), helpLink(m.link));
  if (m.requestId) {
    const line = parts(COPY.stops.request_id, { request_id: m.requestId }).map((p) =>
      p.placeholder === null ? p.text : el("code", { class: "request-id", attrs: { "data-request-id": "" } }, p.text),
    );
    out.push(el("br"), el("span", { attrs: { "data-request-line": "" } }, ...line));
  }
  return out;
}

/** A message area: an ink frame when it holds a message, nothing otherwise. */
function messageArea(): { node: HTMLElement; show: (m: Message | null) => void } {
  const node = el("p", { class: "stop", attrs: { role: "alert", "data-message": "" } });
  return { node, show: (m) => (m ? replace(node, ...messageNodes(m)) : replace(node)) };
}

function stopOf(e: unknown): Stop {
  return e instanceof FlowStop ? e.stop : { code: "engine", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
}

const actions = (...children: (Node | null)[]): HTMLElement => el("div", { class: "actions" }, ...children);
const primary = (label: string | DocumentFragment, onClick: (ev: MouseEvent) => void): HTMLButtonElement => button(label, onClick, "btn");
const secondary = (label: string, onClick: (ev: MouseEvent) => void): HTMLButtonElement => button(label, onClick, "btn ghost");
const textButton = (label: string, onClick: (ev: MouseEvent) => void): HTMLButtonElement => button(label, onClick, "linkbtn");

/**
 * A list of what the page is doing (steps 2 and 5): each item with its state
 * in words; a stop's reason under the item where it stopped. The check mark
 * of a done item is drawn by style.css, in ink.
 */
function taskList(group: "read" | "progress", items: readonly ListItem[]): { node: HTMLElement; render: (states: ItemState[], why?: { at: number; message: Message }) => void } {
  const labels = COPY[group] as Record<string, string>;
  const rows = items.map((item) => {
    const st = el("span", { class: "st" });
    const li = el("li", { class: "task", attrs: { "data-item": item.key, "data-state": "" } }, el("span", { class: "mark", attrs: { "aria-hidden": "true" } }), el("span", { class: "label" }, labels[item.key]!), st);
    return { li, st };
  });
  const node = el("ol", { class: "tasks", attrs: { "data-list": group } }, ...rows.map((r) => r.li));
  const words: Record<ItemState, string> = { "": "", now: COPY.common.working, done: COPY.common.done, halt: COPY.common.halted };
  return {
    node,
    render: (states, why) => {
      for (const [i, r] of rows.entries()) {
        const state = states[i] ?? "";
        r.li.dataset.state = state;
        replace(r.st, words[state]);
        r.li.querySelector(".why")?.remove();
        if (why && why.at === i) r.li.append(el("div", { class: "why", attrs: { "data-why": "" } }, ...messageNodes(why.message)));
      }
    },
  };
}

export function startApp(o: AppOptions): void {
  const root = o.root;
  const card = o.card;
  let flow: CardProofFlow | null = null;
  /** The list on screen listens to the engine's progress. */
  let onProgress: ((step: Progress) => void) | null = null;

  const drop = (): void => {
    flow?.cancel();
    flow = null;
    onProgress = null;
    card.release();
  };

  /** A FlowStop that leaves the step to be tried again (the flow did not end). */
  const retryable = (f: CardProofFlow, e: unknown): e is FlowStop => e instanceof FlowStop && f.stop === null;

  /** Puts a screen up: the mark, where in the six steps (none on the platforms), the screen. */
  function show(step: number | null, screen: HTMLElement): void {
    const where =
      step === null
        ? null
        : el(
            "div",
            { class: "where", attrs: { "data-where": String(step) } },
            el("span", { class: "bar", attrs: { "aria-hidden": "true" } }, ...Array.from({ length: STEPS }, (_, i) => el("i", { class: i < step ? "on" : "" }))),
            el("span", {}, fill(COPY.common.step, { step, steps: STEPS })),
          );
    replace(root, el("header", { class: "top" }, logo(), el("b", {}, COPY.common.service_name)), where, screen);
    document.title = screen.querySelector("h1")?.textContent ?? "";
    window.scrollTo(0, 0);
  }

  function newFlow(p: OpenPlatform): CardProofFlow {
    flow?.cancel();
    const f = createCardProof({
      platform: p.key,
      card,
      prover: o.prover,
      onTiming: o.onTiming,
      onIdle: (stop) => flow === f && before(p, stopMessage(stop, p)),
      onProgress: (step) => flow === f && onProgress?.(step),
    });
    flow = f;
    return f;
  }

  // The platforms ------------------------------------------------------------------

  /** The beginning: cancel, back to the beginning. Everything the last card proof held is dropped first. */
  function platforms(): void {
    drop();
    const c = COPY.platforms;
    // An open platform is a button; one not open yet is listed, and cannot be picked.
    const rows = PLATFORMS.map((p) => {
      if (!p.open) return el("div", { class: "plat off", attrs: { "data-platform": p.key } }, el("b", {}, p.name), el("span", { class: "pill" }, c.not_open));
      const b = el("button", { class: "plat", attrs: { type: "button", "data-platform": p.key } }, el("b", {}, p.name), el("span", { class: "go", attrs: { "aria-hidden": "true" } }));
      b.addEventListener("click", () => before(p));
      return b;
    });
    show(null, el("section", { class: "step", attrs: { "data-step": "platforms" } }, el("h1", { class: "long" }, c.title), el("div", { class: "plats" }, ...rows), el("p", { class: "small" }, c.per_platform)));
  }

  // Step 1: before you start ---------------------------------------------------------

  /**
   * Step 1. `why`: the reason the screen came back here (the wait for the
   * second signature ran out). Until the app is out, no choice of device:
   * back and next (card-proof.md, before the app is out).
   */
  function before(p: OpenPlatform, why: Message | null = null): void {
    drop();
    const c = COPY.before;
    const message = messageArea();
    const faq = (q: string, ...answers: (string | Node)[]): HTMLElement =>
      el("details", { class: "faq" }, el("summary", {}, q), ...answers.map((a) => el("p", {}, a)));
    show(
      1,
      el(
        "section",
        { class: "step", attrs: { "data-step": "before" } },
        message.node,
        el("h1", {}, c.title),
        el("p", { class: "lead" }, c.prepare_card),
        el("p", {}, c.citizens_only),
        faq(c.why_physical, c.why_physical_card, c.why_physical_mobile),
        // The page sends no one elsewhere but to the account's preview: MOICA's page is named, not linked.
        faq(c.how_to_get, c.how_to_get_counter, c.how_to_get_moica),
        actions(secondary(COPY.common.back, () => platforms()), primary(COPY.common.next, () => read(p))),
      ),
    );
    message.show(why);
  }

  // Step 2: read the card -----------------------------------------------------------

  /**
   * Step 2, with nothing read. Going back to it (from step 3) starts a new
   * card proof. `now`: read the card at once (read.read_again pressed on step
   * 5: called in that click, so the component's window may open).
   */
  function read(p: OpenPlatform, o: { now?: boolean } = {}): void {
    drop();
    const c = COPY.read;
    const message = messageArea();
    const list = taskList("read", READ_ITEMS);
    const buttons = el("div", { class: "actions" });
    const back = secondary(COPY.common.back, () => before(p));
    let seen = new Set<Progress>();
    let readButton: HTMLButtonElement | null = null;

    const idle = (label: string): void => {
      readButton = primary(label, (ev) => onRead(ev.currentTarget as HTMLButtonElement));
      replace(buttons, back, readButton);
    };
    idle(c.read_card);
    list.render(itemStates(READ_ITEMS, seen, { running: false, stoppedAt: null }));

    function onRead(pressed: HTMLButtonElement): void {
      // The component's window opens now, in the click (one click, one window).
      if (!card.open()) {
        // Nothing was sent. The same button, once the browser allows the window.
        message.show(stopMessage({ code: "card", card: "popup_blocked" }, p));
        return;
      }
      pressed.disabled = true;
      back.disabled = true;
      message.show(null);
      seen = new Set();
      const f = newFlow(p);
      const render = (): void => list.render(itemStates(READ_ITEMS, seen, { running: true, stoppedAt: null }));
      onProgress = (step) => {
        seen.add(step);
        render();
      };
      render();
      const stopped = (e: unknown): void => {
        if (flow !== f) return;
        card.release();
        onProgress = null;
        back.disabled = false;
        if (retryable(f, e)) {
          // A blocked window: nothing reached the card; the same button again.
          message.show(stopMessage(e.stop, p));
          list.render(itemStates(READ_ITEMS, new Set(), { running: false, stoppedAt: null }));
          idle(c.read_card);
          return;
        }
        const stop = stopOf(e);
        const at = readItemOf(stop) ?? firstNotDone(itemStates(READ_ITEMS, seen, { running: false, stoppedAt: null }));
        list.render(itemStates(READ_ITEMS, seen, { running: false, stoppedAt: at }), { at, message: stopMessage(stop, p) });
        // Another try reads the card again: a new card proof (reading needs no PIN).
        idle(c.read_again);
      };
      f.readCard().then(
        (r) => {
          if (flow !== f) return;
          f.checksDone().then(() => {
            if (flow !== f) return;
            onProgress = null;
            list.render(itemStates(READ_ITEMS, seen, { running: false, stoppedAt: null, allDone: true }));
            back.disabled = false;
            replace(buttons, back, primary(COPY.common.next, () => pin(p, f, r.name)));
          }, stopped);
        },
        stopped,
      );
    }

    show(2, el("section", { class: "step", attrs: { "data-step": "read" } }, el("h1", {}, c.title), el("p", { class: "lead" }, c.insert), message.node, list.node, buttons));
    if (o.now && readButton) onRead(readButton);
  }

  // Step 3: the PIN ------------------------------------------------------------------

  function pin(p: OpenPlatform, f: CardProofFlow, name: string): void {
    const c = COPY.pin;
    const message = messageArea();
    const working = el("span", { class: "busy", attrs: { role: "status", "data-working": "" } });
    const field = el("input", {
      attrs: { id: "pin", type: "password", autocomplete: "off", inputmode: "numeric", autocapitalize: "off", spellcheck: "false" },
    });
    const confirm = primary(c.confirm_card, onConfirm);
    confirm.disabled = true;
    field.addEventListener("input", () => (confirm.disabled = field.disabled || field.value === ""));
    field.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !confirm.disabled) confirm.click();
    });
    // Back reads the card again: a new card proof, the PIN field empty.
    const back = secondary(COPY.common.back, () => read(p));

    function onConfirm(): void {
      // Read once, then the field is empty; the value goes to the engine only.
      const value = field.value;
      field.value = "";
      confirm.disabled = true;
      if (value === "") return; // never sent without a PIN
      if (!card.open()) {
        // Nothing was sent, and the PIN went nowhere: typed again, pressed again.
        message.show(stopMessage({ code: "card", card: "popup_blocked" }, p));
        field.focus();
        return;
      }
      // Until this step ends, neither the field nor the button can be used:
      // pressed again, the card would be asked to sign again.
      field.disabled = true;
      message.show(null);
      replace(working, c.signing);
      f.confirmCard(value).then(
        (status) => flow === f && choose(p, f, status),
        (e) => {
          if (flow !== f) return;
          card.release();
          replace(working);
          message.show(stopMessage(stopOf(e), p));
          // A wrong PIN or a blocked window leaves the step to be tried again; nothing is resent by itself.
          if (retryable(f, e)) {
            field.disabled = false;
            field.focus();
          }
          // Otherwise the card proof ended: back reads the card again.
        },
      );
    }

    show(
      3,
      el(
        "section",
        { class: "step", attrs: { "data-step": "pin" } },
        el("h1", {}, c.title),
        el("div", { class: "cardname", attrs: { "data-card-read": "" } }, el("span", { class: "k" }, c.card_read), el("span", { class: "name" }, name), el("span", { class: "k" }, c.name_note)),
        el("div", { class: "pinfield" }, el("label", { attrs: { for: "pin" } }, c.label), field),
        message.node,
        el("ul", { class: "three" }, el("li", {}, c.purpose), el("li", {}, c.stays), el("li", {}, c.card_and_pin, " ", helpLink("more"))),
        actions(back, confirm, working),
      ),
    );
    field.focus();
  }

  // Step 4: what to do ----------------------------------------------------------------

  /**
   * The account field of step 4, with the preview button (if the platform has
   * public pages). `next` gets the account in the platform's format; a typed
   * one not in it shows the format hint, and nothing is opened.
   */
  function accountField(p: OpenPlatform, label: string, typed: string, next: (u: string) => void, show: (m: Message | null) => void): { nodes: HTMLElement[]; go: () => void } {
    const input = el("input", { attrs: { id: "account", type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false" } });
    input.value = typed;
    const valid = (): string | null => {
      const u = p.normalize(input.value);
      if (p.validUsername(u)) return u;
      show(stopMessage({ code: "username" }, p));
      return null;
    };
    const go = (): void => {
      const u = valid();
      if (u !== null) next(u);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") go();
    });
    queueMicrotask(() => input.focus());
    const profileUrl = p.profileUrl;
    const preview =
      profileUrl === null
        ? null
        : secondary(COPY.choose.preview, () => {
            const u = valid();
            if (u === null) return;
            show(null);
            // A new tab with the account's page: nothing of the card proof goes with it.
            window.open(profileUrl(u), "_blank", "noopener,noreferrer");
          });
    preview?.classList.add("pv");
    const nodes = [
      el("div", { class: "field" }, el("label", { attrs: { for: "account" } }, label), el("span", { class: "at" }, p.prefix), input, preview),
      ...(profileUrl === null ? [] : [el("p", { class: "small" }, fill(COPY.choose.preview_note, { platform: p.name }))]),
    ];
    return { nodes, go };
  }

  const noCheck = (): HTMLElement => el("p", { class: "note" }, COPY.choose.no_check, el("br"), COPY.choose.acknowledged, " ", helpLink("more"));

  /** Cancel on steps 4 and 5: the PIN, the certificate and the signature are dropped, and the screen goes back to the platforms. */
  const cancel = (): HTMLElement => actions(textButton(COPY.common.cancel, () => platforms()));

  /**
   * Picks `choice` in the engine and shows its consequence. A choice the
   * engine refuses (an account not in the format, a switch when none is
   * left) stays on this screen with the message.
   */
  function pick(p: OpenPlatform, f: CardProofFlow, choice: Choice, show: (m: Message | null) => void, back: () => void): void {
    let cq: Consequence;
    try {
      cq = f.choose(choice);
    } catch (e) {
      if (flow !== f) return; // the wait ran out: step 1 is on screen already
      if (retryable(f, e)) return show(stopMessage(e.stop, p));
      return before(p, stopMessage(stopOf(e), p));
    }
    confirmScreen(p, f, cq, back);
  }

  /** Back from step 5: the engine first, then the screen the choice was made on. */
  function goBack(p: OpenPlatform, f: CardProofFlow, to: (status: CardStatus) => void): void {
    let status: CardStatus;
    try {
      status = f.back();
    } catch (e) {
      if (flow === f) before(p, stopMessage(stopOf(e), p));
      return;
    }
    to(status);
  }

  function choose(p: OpenPlatform, f: CardProofFlow, status: CardStatus, typed = ""): void {
    // Step 3, with the name, is taken down here.
    const c = COPY.choose;
    const view = statusView(status, p);
    const message = messageArea();
    const lines = view.lines.map((line, i) => el("p", { class: i === 0 ? "status" : "", attrs: i === 0 ? { "data-status": "" } : { "data-fact": "" } }, ...line.flatMap(messageNodes)));
    const choice = (label: string | DocumentFragment, note: string | DocumentFragment | null, onClick: () => void, enabled = true): HTMLButtonElement => {
      const b = el("button", { class: "choice", attrs: { type: "button", "data-choice": "" } }, el("b", {}, label), note ? el("span", {}, note) : null, el("span", { class: "go", attrs: { "aria-hidden": "true" } }));
      b.disabled = !enabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const switchNote = (): string | DocumentFragment => (view.switchLimit ? say(view.switchLimit) : c.uses_switch);
    let body: (HTMLElement | null)[];
    if (view.dailyLimit) {
      // 3 records of the card today: the state as it is, then this sentence and "back to the beginning" (which drops the PIN, as cancel does).
      body = [el("p", { class: "stop", attrs: { "data-daily-limit": "" } }, say(view.dailyLimit)), actions(secondary(c.restart, () => platforms()))];
    } else if (view.state === "never") {
      const account = accountField(p, c.account_label, typed, (u) => pick(p, f, { action: "declare", username: u }, message.show, () => goBack(p, f, (st) => choose(p, f, st, u))), message.show);
      body = [...account.nodes, el("p", { class: "small" }, fill(c.one_account, { platform: p.name })), message.node, actions(primary(COPY.common.next, account.go)), noCheck(), cancel()];
    } else if (view.state === "declared") {
      const current = status.current!;
      const again = (): void => goBack(p, f, (st) => choose(p, f, st));
      body = [
        el(
          "div",
          { class: "choices" },
          choice(c.refresh, c.refresh_note, () => pick(p, f, { action: "declare", username: current }, message.show, again)),
          choice(c.switch, switchNote(), () => accountScreen(p, f, status, ""), view.canSwitch),
          choice(c.withdraw, null, () => pick(p, f, { action: "withdraw" }, message.show, again)),
        ),
        message.node,
        cancel(),
      ];
    } else {
      const last = status.lastDeclared!;
      body = [
        el(
          "div",
          { class: "choices" },
          choice(sentence(c.declare_back, { last_declared: handle(p, last) }), c.not_a_switch, () =>
            pick(p, f, { action: "declare", username: last }, message.show, () => goBack(p, f, (st) => choose(p, f, st))),
          ),
          choice(c.declare_other, switchNote(), () => accountScreen(p, f, status, ""), view.canSwitch),
        ),
        message.node,
        cancel(),
      ];
    }
    show(4, el("section", { class: "step", attrs: { "data-step": "choose", "data-state": view.dailyLimit ? "daily_limit" : view.state } }, el("h1", {}, c.title), ...lines, ...body));
  }

  /** After choose.switch or choose.declare_other: the new account. */
  function accountScreen(p: OpenPlatform, f: CardProofFlow, status: CardStatus, typed: string): void {
    const c = COPY.choose;
    const message = messageArea();
    const account = accountField(p, c.new_account, typed, (u) => pick(p, f, { action: "declare", username: u }, message.show, () => goBack(p, f, (st) => accountScreen(p, f, st, u))), message.show);
    show(
      4,
      el(
        "section",
        { class: "step", attrs: { "data-step": "account" } },
        el("h1", {}, c.new_account),
        ...account.nodes,
        message.node,
        actions(secondary(COPY.common.back, () => choose(p, f, status)), primary(COPY.common.next, account.go)),
        noCheck(),
        cancel(),
      ),
    );
  }

  // Step 5: confirm, then in progress ---------------------------------------------------

  function confirmScreen(p: OpenPlatform, f: CardProofFlow, cq: Consequence, back: () => void, why: Message | null = null): void {
    const c = COPY.confirm;
    const status = f.cardStatus;
    const view = consequenceView(cq, status?.current ?? null, p);
    const message = messageArea();
    const go = primary(say(view.button), () => {
      // The component's window for the second signature opens now, in the click.
      if (!card.open()) {
        // Nothing was sent; the PIN stays where it was (the engine, until the wait runs out).
        message.show(stopMessage({ code: "card", card: "popup_blocked" }, p));
        return;
      }
      progress(p, f, cq, back);
    });
    show(
      5,
      el(
        "section",
        { class: "step", attrs: { "data-step": "confirm" } },
        el("h1", {}, c.title),
        el("p", {}, c.intro),
        el(
          "div",
          { class: "record", attrs: { "data-record": "" } },
          el("p", { attrs: { "data-record-line": "" } }, say(view.record)),
          el("span", { class: "acct big", attrs: { "data-account": "" } }, view.account),
          el("dl", {}, el("dt", {}, c.date), el("dd", {}, el("time", {}, view.date)), el("dt", {}, c.short_id_label), el("dd", {}, sentence(c.short_id, { short_id: status?.shortId ?? "" }))),
        ),
        view.switchLine && el("p", { class: "stop", attrs: { "data-switch-line": "" } }, say(view.switchLine)),
        el("ul", { class: "three ink" }, el("li", {}, c.no_identity), el("li", {}, view.later.join(""))),
        message.node,
        actions(secondary(COPY.common.back, back), go),
        cancel(),
      ),
    );
    message.show(why);
  }

  function progress(p: OpenPlatform, f: CardProofFlow, cq: Consequence, back: () => void): void {
    const c = COPY.progress;
    // The account the card declared before this card proof, for the title of step 6.
    const current = f.cardStatus?.current ?? null;
    const list = taskList("progress", PROGRESS_ITEMS);
    const zk = el("p", { class: "note", attrs: { "data-zk": "" } }, c.zero_knowledge, " ", helpLink("more"));
    const buttons = el("div", { class: "actions", attrs: { "data-progress-actions": "" } });
    const seen = new Set<Progress>();
    const render = (): void => {
      const states = itemStates(PROGRESS_ITEMS, seen, { running: true, stoppedAt: null });
      list.render(states);
      zk.hidden = states[2] !== "now";
    };
    onProgress = (step) => {
      seen.add(step);
      render();
    };
    render();
    o.prover.ready().then((mode) => (list.node.dataset.threads = String(mode.threads)), () => undefined);

    const finish = (work: Promise<Done>): void => {
      work.then(
        (done) => {
          onProgress = null;
          if (flow === f) doneScreen(p, done, current);
        },
        (e) => {
          card.release();
          if (flow !== f) return;
          onProgress = null;
          const states = itemStates(PROGRESS_ITEMS, seen, { running: false, stoppedAt: null });
          const at = firstNotDone(states);
          const m = stopMessage(stopOf(e), p, f.phase === "submit_failed");
          list.render(itemStates(PROGRESS_ITEMS, seen, { running: false, stoppedAt: at }), { at, message: m });
          zk.hidden = true;
          // The PIN still in the engine (a blocked window: nothing reached the card):
          // back to step 5, the same button again. Otherwise the engine dropped the
          // PIN: the card proof starts again, reading the card in this click.
          const kinds = progressButtons(f.phase);
          replace(
            buttons,
            kinds.includes("back") ? secondary(c.back, () => confirmScreen(p, f, cq, back)) : null,
            kinds.includes("read_again") ? secondary(COPY.read.read_again, () => read(p, { now: true })) : null,
            kinds.includes("retry")
              ? primary(c.retry, () => {
                  replace(buttons);
                  list.render(itemStates(PROGRESS_ITEMS, seen, { running: true, stoppedAt: null }));
                  onProgress = (step) => {
                    seen.add(step);
                    render();
                  };
                  finish(f.resubmit());
                })
              : null,
          );
        },
      );
    };
    show(5, el("section", { class: "step", attrs: { "data-step": "progress" } }, el("h1", {}, c.title), el("p", { class: "lead" }, c.keep_open), list.node, zk, buttons));
    finish(f.proceed(cq.username));
  }

  // Step 6: done -----------------------------------------------------------------------

  function doneScreen(p: OpenPlatform, d: Done, current: string | null): void {
    const c = COPY.done;
    flow = null;
    const view = doneView(d, current, p);
    const mine: (HTMLElement | null)[] = [];
    if (!view.withdraw) {
      const copy = primary(c.copy, () => {
        // The whole https:// address, so that a profile turns it into a link.
        navigator.clipboard.writeText(view.url).then(
          () => replace(copy, c.copied),
          () => undefined,
        );
      });
      mine.push(
        el(
          "div",
          { class: "cert", attrs: { "data-proof": "" } },
          el("div", { class: "cert-top" }, el("span", {}, c.proof), el("span", { class: "pill" }, p.name)),
          el("div", { class: "cert-acct acct" }, view.account),
          el("dl", {}, el("dt", {}, COPY.confirm.date), el("dd", {}, el("time", {}, view.date)), el("dt", {}, COPY.confirm.short_id_label), el("dd", {}, sentence(COPY.confirm.short_id, { short_id: view.shortId }))),
          el("p", { class: "hand cert-note" }, c.hand_ai, el("br"), c.hand_profile),
        ),
        el("h2", { class: "put-up" }, c.put_up),
        el("p", {}, sentence(c.put_link, { account: view.account, platform: p.name })),
        view.otherCards && el("p", { class: "small", attrs: { "data-other-cards": "" } }, say(view.otherCards)),
        el("div", { class: "linkbox" }, el("span", { class: "id", attrs: { "data-link": "" } }, view.link), copy),
        el("p", { class: "small" }, helpLink("proof")),
      );
    }
    show(
      6,
      el(
        "section",
        { class: "step", attrs: { "data-step": "done", "data-kind": d.kind } },
        view.withdraw ? null : el("div", { class: "hero" }, logo({ animated: true })),
        el("h1", {}, say(view.title)),
        ...mine,
        el("h2", {}, c.recorded),
        el("p", { class: "rec6", attrs: { "data-record": "" } }, el("time", {}, view.date), say(view.record), say(view.shortIdLine)),
        el("ul", { class: "three ink" }, view.withdraw ? null : el("li", {}, c.advice), el("li", {}, c.trust, " ", helpLink("verify"))),
        el("p", {}, c.unplug),
        // Another card proof, with the same engine (ADR-0013).
        actions(secondary(c.restart, () => platforms())),
      ),
    );
  }

  platforms();
}
