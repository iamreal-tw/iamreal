// The screens of a card proof (design/copy/card-proof.md): seven steps, one
// screen each: before you start, read the card, the PIN, your accounts,
// confirm (and in progress), hang it on the profile, done and share. There is no screen to pick a platform:
// one card proof covers the card's whole list of accounts (ADR-0017). First
// the card is confirmed, then the cardholder edits the list, then the list
// is declared. Three clicks open the component's window: read the card,
// confirm the card (first signature), the last button of step 5 (second
// signature). On top of the engine (src/flow.ts). The screen holds no value
// longer than it shows it:
//
//   - The PIN is read from its field when "confirm" is clicked, the field is
//     emptied at once, and the value goes to the engine and nowhere else (no
//     storage, URL, log, global or DOM attribute). The field is not in a form
//     and has no name, so the browser has nothing to remember it by. Until
//     that step ends, the field and the button cannot be used. The engine
//     holds it until the second signature, and drops it if that is not made
//     within 5 minutes of the first, or when "cancel" or "back to the
//     beginning" is pressed (the screen then goes back to step 1).
//   - The name on the certificate is shown on step 3 only; the screen keeps
//     it while step 3 is up.
//   - The accounts typed are kept in this module's memory while steps 4 and
//     5 are up (to fill the rows again after going back); they are not stored.
//
// A window the browser blocks sends nothing: the screen says so, and the same
// button can be pressed again once the cardholder allowed the windows.
//
// Steps 1 to 5 send the cardholder elsewhere in a few places only, each in
// a new tab with noopener and noreferrer (docs/design/principles.md,
// principle 1: no link out by default): accounts.preview opens the
// account's page on the platform (window.open); step 1's question on how to
// get a card links to a map's search for household registration offices
// and to MOICA, for someone with no card yet (design/copy/card-proof.md,
// step 1, why); and the link written after a stop that the cardholder
// cannot get past on this page (links.prepare, after
// stops.component_unreachable, to the site's page /prepare). The new tab
// gets the account typed or a fixed address and nothing else; this page
// loads nothing from the platform, and asks for no location.
//
// Every sentence comes from copy.ts; the platforms, their display names and
// formats from the server's table (the engine's CardStatus); each
// platform's prefix, hint and address from src/platforms.ts. ids and data-*
// attributes are for the headless browser test and hold no value.
import { type CardProofFlow, type CardStatus, type Config, type Consequence, type Done, FlowStop, type Progress, type Prover, type Stop, askToStart, cardProofsPaused, pageCounts, createCardProof, presentationOf } from "../index.ts";
import type { Card } from "../card/card.ts";
import { COPY, fill, parts } from "./copy.ts";
import { button, el, replace, sentence } from "./dom.ts";
import { frame } from "./frame.ts";
import { logo } from "./logo.ts";
import { qrSvg } from "./qr.ts";
import {
  type AccountRowView,
  type DeclaredView,
  type DoneView,
  type FillView,
  type HelpTopic,
  type ItemState,
  type ListItem,
  type Message,
  PROGRESS_ITEMS,
  READ_ITEMS,
  type Sentence,
  accountsView,
  beforeView,
  confirmView,
  doneView,
  editListView,
  firstNotDone,
  itemStates,
  onePlatform,
  progressButtons,
  readItemOf,
  stopMessage,
  switchView,
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

/** The seven steps of the web (card-proof.md: the app has a reminder between hanging it and done, eight). */
const STEPS = 7;

/** Where a help link goes: what a card proof needs, a page of the site (/prepare, made by the Worker). */
const HELP_HREF: Record<HelpTopic, string> = { prepare: "/prepare" };

/**
 * before.find_office: a map's search for household registration offices
 * (the word the copy uses for them, percent-encoded), Google Maps' search URL
 * (https://developers.google.com/maps/documentation/urls/get-started). The
 * map finds what is near; this page asks for no location.
 */
const FIND_OFFICE_HREF = "https://www.google.com/maps/search/?api=1&query=%E6%88%B6%E6%94%BF%E4%BA%8B%E5%8B%99%E6%89%80";
/** before.how_to_get_moica: MOICA's site (its page on applying blocks automated reading, so it is not checked yet: card-proof.md, step 1). */
const MOICA_HREF = "https://moica.nat.gov.tw/";

/** A link out of the page: in a new tab, as leaving this page would end the card proof. */
function newTab(href: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLAnchorElement {
  return el("a", { attrs: { href, target: "_blank", rel: "noopener noreferrer", ...attrs } }, ...children);
}

function helpLink(topic: HelpTopic): HTMLAnchorElement {
  return newTab(HELP_HREF[topic], { "data-help": topic }, COPY.links[topic]);
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
/** Buttons with no "back" before them: the main one at the end of the row, where it is when there is one. */
const actionsEnd = (...children: (Node | null)[]): HTMLElement => el("div", { class: "actions end" }, ...children);
const primary = (label: string | DocumentFragment, onClick: (ev: MouseEvent) => void): HTMLButtonElement => button(label, onClick, "btn");
const secondary = (label: string, onClick: (ev: MouseEvent) => void): HTMLButtonElement => button(label, onClick, "btn ghost");
const textButton = (label: string | DocumentFragment, onClick: (ev: MouseEvent) => void): HTMLButtonElement => button(label, onClick, "linkbtn");

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

  /** Puts a screen up: the mark, the service's name and the site's; where in the seven steps; the screen. */
  function show(step: number, screen: HTMLElement): void {
    const where = el(
      "div",
      { class: "where", attrs: { "data-where": String(step) } },
      el("p", { class: "count" }, fill(COPY.common.step, { step, steps: STEPS })),
      el("span", { class: "bar", attrs: { "aria-hidden": "true" } }, ...Array.from({ length: STEPS }, (_, i) => el("i", { class: i < step ? "on" : "" }))),
    );
    frame(root, where, screen);
    document.title = screen.querySelector("h1")?.textContent ?? "";
    window.scrollTo(0, 0);
  }

  /** What `config` answered when the cardholder last pressed common.next on step 1 (askToStart): the card proofs that follow fall back on it. */
  let startConfig: Config | null = null;

  function newFlow(): CardProofFlow {
    flow?.cancel();
    const f = createCardProof({
      card,
      prover: o.prover,
      startConfig,
      onTiming: o.onTiming,
      onIdle: (stop) => flow === f && before(stopMessage(stop)),
      onProgress: (step) => flow === f && onProgress?.(step),
    });
    flow = f;
    return f;
  }

  // Step 1: before you start ---------------------------------------------------------

  /**
   * Step 1, the beginning: common.cancel and accounts.restart come back here. Everything the
   * last card proof held is dropped first. `why`: the reason the screen came
   * back here (the wait for the second signature ran out). The first screen
   * has no common.back; until the app is out, no choice of device: common.next only
   * (card-proof.md, before the app is out).
   */
  function before(why: Message | null = null): void {
    drop();
    const c = COPY.before;
    const view = beforeView();
    const message = messageArea();
    const faq = (q: string, ...answers: (string | Node)[]): HTMLElement =>
      el("details", {}, el("summary", {}, q), ...answers.map((a) => el("p", {}, a)));
    const pausedLine = (): HTMLElement => el("p", { class: "stop", attrs: { role: "status", "data-paused": "" } }, c.paused);
    // Too many people now (card-proof.md, step 1, the section on too many people): above common.next, which stays to be pressed again.
    const busyLine = el("p", { class: "stop", attrs: { role: "status", "data-busy": "" } }, c.busy);
    // The start of a card proof: `config` asked with its mark, the one request counted against the site-wide
    // limit (ADR-0026), before a card is read or the component's window opens. No answer: on to step 2, which asks again.
    const start = primary(COPY.common.next, () => {
      start.disabled = true;
      busyLine.remove();
      askToStart().then((answer) => {
        start.disabled = false;
        if (!next.isConnected) return;
        if (answer === "busy" || answer === "rate_limited") {
          // Step 1 stays, to be pressed again: a retry, with the server's code (spec/counts.md).
          pageCounts().retry(answer === "busy" ? "server_busy" : "server_rate_limited");
          return void next.before(busyLine);
        }
        if (answer === "paused") return void next.replaceWith(pausedLine());
        startConfig = answer;
        read();
      });
    });
    const next = actionsEnd(start);
    // The operator stopped taking card proofs: said here, before a card is read, in place of common.next
    // (card-proof.md, step 1). No answer: common.next stays, and step 2 asks again.
    cardProofsPaused().then((paused) => {
      if (paused === true && next.isConnected) next.replaceWith(pausedLine());
    });
    show(
      1,
      el(
        "section",
        { class: "step", attrs: { "data-step": "before" } },
        message.node,
        el("h1", {}, c.title),
        // How long it takes, once the card and the reader are at hand (on the web only: the app has no reader).
        el("p", { class: "lead" }, c.duration),
        el("p", { class: "lead strong" }, c.prepare_card),
        el("p", { class: "lead" }, c.citizens_only),
        // By the platforms the device knows (there is no platform table yet): with more than one, that their accounts are
        // listed together, as plain to see as the lines above, not in a question to open (it may change whether to go on,
        // and cannot be undone). With one, nothing: step 5's first sentence says it is made public.
        view.oneProof ? el("p", { class: "lead", attrs: { "data-one-proof": "" } }, say(view.oneProof)) : null,
        view.listedTogether ? el("p", { class: "lead", attrs: { "data-listed-together": "" } }, c.listed_together) : null,
        next,
        el(
          "div",
          { class: "asks" },
          faq(c.why_physical, c.why_physical_card, c.why_physical_mobile),
          // Someone with no card yet cannot get past this step: where to get one, in new tabs (card-proof.md, step 1).
          faq(
            c.how_to_get,
            c.how_to_get_counter,
            newTab(FIND_OFFICE_HREF, { class: "btn ghost", "data-find-office": "" }, c.find_office),
            newTab(MOICA_HREF, { "data-moica": "" }, c.how_to_get_moica),
          ),
        ),
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
  function read(o: { now?: boolean } = {}): void {
    drop();
    const c = COPY.read;
    const message = messageArea();
    const list = taskList("read", READ_ITEMS);
    const buttons = el("div", { class: "actions" });
    const back = secondary(COPY.common.back, () => before());
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
        pageCounts().retry("popup_blocked");
        message.show(stopMessage({ code: "card", card: "popup_blocked" }));
        return;
      }
      pressed.disabled = true;
      back.disabled = true;
      message.show(null);
      seen = new Set();
      const f = newFlow();
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
          message.show(stopMessage(e.stop));
          list.render(itemStates(READ_ITEMS, new Set(), { running: false, stoppedAt: null }));
          idle(c.read_card);
          return;
        }
        const stop = stopOf(e);
        const at = readItemOf(stop) ?? firstNotDone(itemStates(READ_ITEMS, seen, { running: false, stoppedAt: null }));
        list.render(itemStates(READ_ITEMS, seen, { running: false, stoppedAt: at }), { at, message: stopMessage(stop) });
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
            replace(buttons, back, primary(COPY.common.next, () => pin(f, r.name)));
          }, stopped);
        },
        stopped,
      );
    }

    show(2, el("section", { class: "step", attrs: { "data-step": "read" } }, el("h1", {}, c.title), el("p", { class: "lead" }, c.insert), message.node, list.node, buttons));
    if (o.now && readButton) onRead(readButton);
  }

  // Step 3: the PIN ------------------------------------------------------------------

  function pin(f: CardProofFlow, name: string): void {
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
    const back = secondary(COPY.common.back, () => read());

    function onConfirm(): void {
      // Read once, then the field is empty; the value goes to the engine only.
      const value = field.value;
      field.value = "";
      confirm.disabled = true;
      if (value === "") return; // never sent without a PIN
      if (!card.open()) {
        // Nothing was sent, and the PIN went nowhere: typed again, pressed again.
        pageCounts().retry("popup_blocked");
        message.show(stopMessage({ code: "card", card: "popup_blocked" }));
        field.focus();
        return;
      }
      // Until this step ends, neither the field, the button nor "back" can be
      // used: pressed again, the card would be asked to sign again; back, a
      // new card proof would open a second window while the card signs in the
      // first.
      field.disabled = true;
      back.disabled = true;
      message.show(null);
      replace(working, c.signing);
      f.confirmCard(value).then((status) => flow === f && accounts(f, status), stopped);
    }

    function stopped(e: unknown): void {
      if (flow !== f) return;
      card.release();
      replace(working);
      back.disabled = false;
      message.show(stopMessage(stopOf(e)));
      if (retryable(f, e) && f.phase === "card_state_failed") {
        // The card signed; the server said too many people to its state (card-proof.md, step 3): asked again
        // with nothing signed again, so neither the PIN nor the card is needed.
        confirm.hidden = true;
        const again = primary(COPY.progress.retry, () => {
          again.remove();
          back.disabled = true;
          message.show(null);
          replace(working, c.signing);
          f.retryCardState().then((status) => flow === f && accounts(f, status), stopped);
        });
        again.dataset.retry = "";
        working.after(again);
        return;
      }
      // A wrong PIN or a blocked window leaves the step to be tried again; nothing is resent by itself.
      if (retryable(f, e)) {
        field.disabled = false;
        field.focus();
      }
      // Otherwise the card proof ended: back reads the card again.
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
        // Two of the three things to say before the PIN; the third (who holds the card and the PIN can look the accounts up) is said once, on step 5.
        el("ul", { class: "facts" }, el("li", {}, c.purpose), el("li", {}, c.stays)),
        // What the card is doing, beside the button it follows from, at the end of the row.
        actions(back, el("div", { class: "go" }, working, confirm)),
      ),
    );
    field.focus();
  }

  // Step 4: your accounts -----------------------------------------------------------------

  /** Cancel on steps 4 and 5: the PIN, the certificate and the signature are dropped, and the screen goes back to step 1. */
  const cancel = (): HTMLElement => actions(textButton(COPY.common.cancel, () => before()));

  /**
   * Which screen of step 4: as it opens (accountsView: rows to fill, or what
   * the card declares and the actions); accounts.switch (one platform);
   * accounts.edit_list (more than one). `typed`: what the field(s) held when
   * step 5 went back here.
   */
  interface AccountsScreen {
    mode: "open" | "switch" | "edit";
    typed?: Readonly<Record<string, string>>;
  }

  /**
   * Step 4 (design/copy/card-proof.md, step 4). Whatever is pressed, what
   * goes on is one list (the engine's choose), and step 5 next: the card's
   * list as it is (accounts.refresh), with one account changed, with it
   * withdrawn, or the rows as typed.
   */
  function accounts(f: CardProofFlow, status: CardStatus, screen: AccountsScreen = { mode: "open" }): void {
    // Step 3, with the name, is taken down here.
    if (screen.mode === "switch") return switchScreen(f, status, screen.typed ?? null);
    if (screen.mode === "edit") return listScreen(f, status, editListView(status), { typed: screen.typed ?? null, editList: true });
    const view = accountsView(status);
    if (view.mode === "fill") return listScreen(f, status, view, { typed: screen.typed ?? null, editList: false });
    declaredScreen(f, status, view);
  }

  /** The list of step 4 sent as `entries`: step 5, or the reason it cannot be, under a row or under the list. */
  function choose(f: CardProofFlow, entries: Record<string, string>, comeBack: (status: CardStatus) => void, showUnder: (platform: string | null, m: Message) => void): void {
    let cq: Consequence;
    try {
      cq = f.choose(entries);
    } catch (e) {
      if (flow !== f) return; // the wait ran out: step 1 is on screen already
      if (retryable(f, e)) {
        const stop = e.stop;
        // A row's problem under the row; the list's (empty, 3 today) under the list.
        return showUnder((stop.code === "username" || stop.code === "blocked") && stop.platform ? stop.platform : null, stopMessage(stop));
      }
      return before(stopMessage(stopOf(e)));
    }
    confirmScreen(f, cq, () => goBack(f, comeBack));
  }

  /** The card's list as it is: each platform the screen offers, its account now or "". */
  const listNow = (status: CardStatus): Record<string, string> => Object.fromEntries(status.slots.filter((sl) => sl.row !== null).map((sl) => [sl.platform, sl.current ?? ""]));

  /** 3 records of the card today: the sentence, and "back to the beginning" (which drops the PIN, as cancel does). */
  const dailyLimitBody = (s: Sentence): HTMLElement[] => [el("p", { class: "stop", attrs: { "data-daily-limit": "" } }, say(s)), actions(secondary(COPY.accounts.restart, () => before()))];

  /** Step 4's screen, with the seven steps' line above it, and its state for the tests. */
  function showAccounts(state: string, mode: string, ...children: (Node | null)[]): void {
    show(4, el("section", { class: "step", attrs: { "data-step": "accounts", "data-state": state, "data-mode": mode } }, ...children));
  }

  /**
   * The card declares accounts: what it declares and when it last did,
   * accounts.refresh (the list as it is), and with one platform
   * accounts.switch and accounts.withdraw, with more accounts.edit_list.
   * On a day with 3 records, none of them: the sentence and
   * accounts.restart.
   */
  function declaredScreen(f: CardProofFlow, status: CardStatus, view: DeclaredView): void {
    const a = COPY.accounts;
    const message = messageArea();
    const current = el(
      "div",
      { class: view.current.some((c) => c.name !== null) ? "current list" : "current", attrs: { "data-current": "" } },
      ...view.current.map((c) =>
        el(
          "p",
          { class: "current-row", attrs: { "data-current-row": c.platform } },
          c.name === null ? null : el("span", { class: "plat-name" }, c.name),
          el("span", { class: c.raw ? "acct raw" : "acct", attrs: { "data-current-account": "" } }, c.account),
          c.line ? el("span", { class: "row-lines", attrs: { "data-row-line": "" } }, say(c.line)) : null,
        ),
      ),
    );
    const here = (s: CardStatus): void => accounts(f, s);
    const showHere = (_platform: string | null, m: Message): void => message.show(m);
    const body: (HTMLElement | null)[] = view.dailyLimit
      ? dailyLimitBody(view.dailyLimit)
      : [
          message.node,
          // The main button: the list as it is, nothing to type.
          el("div", { class: "refresh" }, primary(a.refresh, () => choose(f, listNow(status), here, showHere)), el("p", { class: "small", attrs: { "data-refresh-note": "" } }, say(view.refreshNote))),
          el(
            "div",
            { class: "more", attrs: { "data-more": "" } },
            view.switchAccount ? textButton(a.switch, () => accounts(f, status, { mode: "switch" })) : null,
            // Withdrawn: the list without it (one platform: the empty list).
            view.withdraw ? textButton(say(view.withdraw), () => choose(f, Object.fromEntries(Object.keys(listNow(status)).map((p) => [p, ""])), here, showHere)) : null,
            view.editList ? textButton(a.edit_list, () => accounts(f, status, { mode: "edit" })) : null,
          ),
          cancel(),
        ];
    showAccounts(
      view.dailyLimit ? "daily_limit" : "declared",
      "declared",
      el("h1", {}, say(view.title)),
      el("p", { class: "status", attrs: { "data-status": "" } }, COPY.accounts.declared_now),
      current,
      el("p", { class: "last", attrs: { "data-last": "" } }, ...messageNodes(view.last)),
      ...body,
    );
  }

  /** A row with a field (and a preview), registered in `fields`; or, for a platform the device does not know or on a day with 3 records, the row as it is. */
  function rowNode(r: AccountRowView, value: string, fields: Map<string, { input: HTMLInputElement; why: HTMLElement }>, o: { onEnter: () => void; valid: (platform: string) => string | null }): HTMLElement {
    const a = COPY.accounts;
    const lines = el("div", { class: "row-lines" }, ...r.lines.map((l) => el("p", { attrs: { "data-row-line": "" } }, say(l))));
    const why = el("p", { class: "stop", attrs: { role: "alert", "data-row-message": "" } });
    if (!r.editable) {
      // A platform the device does not know (kept as the server sent it), or a day with 3 records: the row as it is.
      return el(
        "div",
        { class: "acctrow fixed", attrs: { "data-row": r.platform, "data-fixed": "" } },
        el("span", { class: "plat-name" }, r.name),
        el("span", { class: r.raw ? "acct raw" : "acct", attrs: { "data-row-account": "" } }, r.current === "" ? "" : r.prefix + r.current),
        lines,
      );
    }
    const input = el("input", { attrs: { id: `account-${r.platform}`, type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "data-account-field": r.platform } });
    input.value = value;
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") o.onEnter();
    });
    fields.set(r.platform, { input, why });
    const preview = r.preview
      ? secondary(a.preview, () => {
          const u = o.valid(r.platform);
          if (u === null || u === "") return;
          const url = presentationOf(r.platform)!.profileUrl!(u);
          // A new tab with the account's page: nothing of the card proof goes with it.
          window.open(url, "_blank", "noopener,noreferrer");
        })
      : null;
    preview?.classList.add("pv");
    return el(
      "div",
      { class: "acctrow", attrs: { "data-row": r.platform } },
      el("label", { class: "plat-name", attrs: { for: `account-${r.platform}` } }, r.name),
      el("div", { class: "field" }, r.prefix ? el("span", { class: "at" }, r.prefix) : null, input),
      preview,
      lines,
      why,
    );
  }

  /** The fields of a screen, and the account typed on each (tidied, presentationOf), or the format hint under the row. */
  function fieldSet(status: CardStatus, message: { show: (m: Message | null) => void }) {
    const fields = new Map<string, { input: HTMLInputElement; why: HTMLElement }>();
    const showUnder = (platform: string | null, m: Message): void => {
      const field = platform === null ? undefined : fields.get(platform);
      if (field) replace(field.why, ...messageNodes(m));
      else message.show(m);
    };
    /** The account typed on a row; "" for none. Shows the format hint under the row and returns null if it is not in the format. */
    const valid = (platform: string): string | null => {
      const field = fields.get(platform)!;
      const slot = status.slots.find((sl) => sl.platform === platform)!;
      const u = presentationOf(platform)!.normalize(field.input.value);
      if (u === "" || slot.row!.format.accepts(u)) {
        replace(field.why);
        return u;
      }
      pageCounts().retry("username");
      showUnder(platform, stopMessage({ code: "username", platform }));
      return null;
    };
    return { fields, showUnder, valid };
  }

  /**
   * Rows to fill, one per platform of the server's table that the card's
   * state has an entry for, and a row that cannot be changed for each
   * account on a platform the device does not know: the card declares
   * nothing (a row filled is a new declaration), or after
   * accounts.edit_list (each row changed on its own: filled, changed,
   * emptied). `editList`: opened with accounts.edit_list; accounts.keep goes
   * back to what the card declares.
   */
  function listScreen(f: CardProofFlow, status: CardStatus, view: FillView, o: { typed: Readonly<Record<string, string>> | null; editList: boolean }): void {
    const message = messageArea();
    const { fields, showUnder, valid } = fieldSet(status, message);
    const rowNodes = view.rows.map((r) => rowNode(r, o.typed?.[r.platform] ?? r.current, fields, { onEnter: next, valid }));

    function next(): void {
      message.show(null);
      const entries: Record<string, string> = {};
      let ok = true;
      for (const platform of fields.keys()) {
        const u = valid(platform);
        if (u === null) ok = false;
        else entries[platform] = u;
      }
      if (!ok) return;
      // Back from step 5: the same rows, as they were typed.
      choose(f, entries, (st) => accounts(f, st, { mode: o.editList ? "edit" : "open", typed: entries }), showUnder);
    }

    const notes = view.notes.length ? el("div", { class: "tips" }, ...view.notes.map((n) => el("p", {}, ...n.map((x) => say(x))))) : null;
    const body: (HTMLElement | null)[] = view.dailyLimit
      ? dailyLimitBody(view.dailyLimit)
      : [notes, message.node, actionsEnd(primary(COPY.common.next, next)), o.editList ? actions(textButton(COPY.accounts.keep, () => accounts(f, status))) : null, cancel()];
    const lead = view.lead.map((line, i) => el("p", { class: i === 0 ? "status" : "", attrs: i === 0 ? { "data-status": "" } : { "data-fact": "" } }, ...line.flatMap((m) => messageNodes(m))));
    showAccounts(view.dailyLimit ? "daily_limit" : view.state, o.editList ? "edit" : "fill", el("h1", {}, say(view.title)), ...lead, el("div", { class: "acctlist", attrs: { "data-list": "accounts" } }, ...rowNodes), ...body);
    queueMicrotask(() => [...fields.values()][0]?.input.focus());
  }

  /** accounts.switch (one platform): the account now, a field for another, what it does and what it costs; accounts.keep goes back. */
  function switchScreen(f: CardProofFlow, status: CardStatus, typed: Readonly<Record<string, string>> | null): void {
    const a = COPY.accounts;
    const view = switchView(status);
    const message = messageArea();
    const { fields, showUnder, valid } = fieldSet(status, message);
    const row = view.row;

    function next(): void {
      message.show(null);
      const u = valid(row!.platform);
      if (u === null) return;
      // Withdrawing is the other action: an empty field goes nowhere.
      if (u === "") {
        pageCounts().retry("blocked_empty");
        return showUnder(row!.platform, stopMessage({ code: "blocked", reason: "empty" }));
      }
      const entries = { ...listNow(status), [row!.platform]: u };
      choose(f, entries, (st) => accounts(f, st, { mode: "switch", typed: entries }), showUnder);
    }

    const keep = actions(textButton(a.keep, () => accounts(f, status)));
    const lines = el("div", { class: "tips", attrs: { "data-switch-lines": "" } }, el("p", {}, ...view.lines.map((l) => say(l))), view.previewNote ? el("p", {}, say(view.previewNote)) : null);
    showAccounts(
      "declared",
      "switch",
      el("h1", {}, say(view.title)),
      el("p", { class: "status", attrs: { "data-status": "" } }, say(view.intro)),
      row ? el("h2", { class: "switch-title" }, a.switch) : null,
      row ? el("div", { class: "acctlist", attrs: { "data-list": "accounts" } }, rowNode(row, typed?.[row.platform] ?? "", fields, { onEnter: next, valid })) : null,
      lines,
      message.node,
      row ? actionsEnd(primary(COPY.common.next, next)) : null,
      keep,
      cancel(),
    );
    queueMicrotask(() => [...fields.values()][0]?.input.focus());
  }

  /** Back from step 5: the engine first, then step 4 as it was left. */
  function goBack(f: CardProofFlow, to: (status: CardStatus) => void): void {
    let status: CardStatus;
    try {
      status = f.back();
    } catch (e) {
      if (flow === f) before(stopMessage(stopOf(e)));
      return;
    }
    to(status);
  }

  // Step 5: confirm, then in progress ---------------------------------------------------

  function confirmScreen(f: CardProofFlow, cq: Consequence, back: () => void, why: Message | null = null): void {
    const c = COPY.confirm;
    const status = f.cardStatus;
    const single = status === null ? null : onePlatform(status);
    // The points name the platforms of the screens: the one, or each the device knows of the server's table.
    const names = status === null ? [] : status.tablePlatforms.map((p) => presentationOf(p)?.name ?? p);
    const view = confirmView(cq, single, single !== null ? [single] : names);
    const message = messageArea();
    const go = primary(view.button, () => {
      // The component's window for the second signature opens now, in the click.
      if (!card.open()) {
        // Nothing was sent; the PIN stays where it was (the engine, until the wait runs out).
        pageCounts().retry("popup_blocked");
        message.show(stopMessage({ code: "card", card: "popup_blocked" }));
        return;
      }
      progress(f, cq, back, single);
    });
    // The whole list to be signed, and each row's consequence, withdrawals included; the platform's ID under its name
    // (README.md, the platform table comes from the server).
    const pair = (dt: HTMLElement, dd: HTMLElement): HTMLElement => el("div", {}, dt, dd);
    const rows = view.rows.map((r) =>
      pair(
        el("dt", { attrs: { "data-confirm-row": r.platform } }, r.name, " ", el("code", { class: "plat-id", attrs: { "data-platform-id": "" } }, r.id)),
        el("dd", { attrs: { "data-confirm-row": r.platform } }, el("span", { class: r.raw ? "acct raw" : "acct", attrs: { "data-account": "" } }, r.account), ...r.lines.map((l) => el("span", { class: "kind", attrs: { "data-kind": "" } }, say(l)))),
      ),
    );
    show(
      5,
      el(
        "section",
        { class: "step", attrs: { "data-step": "confirm" } },
        el("h1", {}, c.title),
        el("p", { class: "lead", attrs: { "data-intro": "" } }, view.intro),
        el(
          "dl",
          { class: "sumlist", attrs: { "data-record": "" } },
          ...rows,
          pair(el("dt", {}, c.date), el("dd", {}, el("time", {}, view.date))),
          pair(el("dt", {}, c.short_id_label), el("dd", {}, sentence(c.short_id, { short_id: status?.shortId ?? "" }))),
        ),
        view.withdrawStays ? el("p", { class: "small", attrs: { "data-withdraw-stays": "" } }, c.withdraw_stays) : null,
        // More than one platform: as plain to see as the list, above the buttons, apart from the points below.
        // With one, the first sentence says the account is made public.
        view.listedTogether ? el("p", { class: "public", attrs: { "data-listed-together": "" } }, c.listed_together) : null,
        // The points; the words that no record can be deleted in bold ink (confirm.cannot_delete).
        // Each point in one element: the list item is a grid of the dot and the words.
        el("ul", { class: "facts", attrs: { "data-points": "" } }, ...view.points.map((pt) => el("li", {}, el("span", {}, say(pt))))),
        message.node,
        actions(secondary(COPY.common.back, back), go),
        cancel(),
      ),
    );
    message.show(why);
  }

  /** `single`: the one platform's name when the screens speak of one platform (onePlatform, as step 5 decided it); null otherwise. */
  function progress(f: CardProofFlow, cq: Consequence, back: () => void, single: string | null): void {
    const c = COPY.progress;
    const list = taskList("progress", PROGRESS_ITEMS);
    const buttons = el("div", { class: "actions", attrs: { "data-progress-actions": "" } });
    const seen = new Set<Progress>();
    const render = (): void => {
      list.render(itemStates(PROGRESS_ITEMS, seen, { running: true, stoppedAt: null }));
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
          if (flow === f) doneScreen(done, single);
        },
        (e) => {
          card.release();
          if (flow !== f) return;
          onProgress = null;
          const states = itemStates(PROGRESS_ITEMS, seen, { running: false, stoppedAt: null });
          const at = firstNotDone(states);
          const m = stopMessage(stopOf(e), f.phase === "submit_failed");
          list.render(itemStates(PROGRESS_ITEMS, seen, { running: false, stoppedAt: at }), { at, message: m });
          // The PIN still in the engine (a blocked window: nothing reached the card):
          // back to step 5, the same button again. Otherwise the engine dropped the
          // PIN: the card proof starts again, reading the card in this click.
          const kinds = progressButtons(f.phase, stopOf(e));
          replace(
            buttons,
            kinds.includes("back") ? secondary(c.back, () => confirmScreen(f, cq, back)) : null,
            kinds.includes("read_again") ? secondary(COPY.read.read_again, () => read({ now: true })) : null,
            // The date changed and nothing was signed: from the beginning (stops.date_changed).
            kinds.includes("restart") ? secondary(COPY.accounts.restart, () => before()) : null,
            kinds.includes("retry")
              ? primary(c.retry, () => {
                  // Too many people when the challenge was asked (phase "chosen"): asked again, and the card signs;
                  // the component's window opens in this click. Otherwise the same submission again.
                  const again = f.phase === "chosen";
                  if (again && !card.open()) return void list.render(itemStates(PROGRESS_ITEMS, seen, { running: false, stoppedAt: at }), { at, message: stopMessage({ code: "card", card: "popup_blocked" }) });
                  replace(buttons);
                  list.render(itemStates(PROGRESS_ITEMS, seen, { running: true, stoppedAt: null }));
                  onProgress = (step) => {
                    seen.add(step);
                    render();
                  };
                  finish(again ? f.proceed(cq.accounts) : f.resubmit());
                })
              : null,
          );
        },
      );
    };
    show(5, el("section", { class: "step", attrs: { "data-step": "progress" } }, el("h1", {}, c.title), el("p", { class: "lead" }, c.keep_open), list.node, buttons));
    finish(f.proceed(cq.accounts));
  }

  // After the submission: step 6, hang it; the last step, done and share ------------

  /**
   * Where the submission leads (design/copy/card-proof.md, steps 6 and 8;
   * the web has no reminder, so its last step is 7). Everything withdrawn:
   * straight to the last step, nothing to hang or share. Otherwise step 6,
   * short for a card proof again with one platform. The card proof is over:
   * the engine holds nothing, and going back between steps 6 and 7 asks
   * nothing of the card.
   */
  function doneScreen(d: Done, single: string | null): void {
    flow = null;
    const view = doneView(d, single);
    if (view.withdrawAll) return finishScreen(view, null);
    hangScreen(view, view.short);
  }

  /** The day the proof log recorded it, that the card can come out, and when the kinds could not be read, that sentence. */
  function recordedLines(view: DoneView): HTMLElement[] {
    return [
      el("p", { class: "recorded", attrs: { "data-recorded-on": "" } }, say(view.recordedOn), COPY.done.unplug),
      ...(view.kindsUnreadable ? [el("p", { class: "small", attrs: { "data-kinds-unreadable": "" } }, COPY.done.kinds_unreadable)] : []),
    ];
  }

  /** What the server recorded is not what step 5 said: the sentence first of all, and the record (only then). */
  function recordParts(view: DoneView): { note: HTMLElement | null; record: HTMLElement[] } {
    const t = COPY.done;
    const note = view.mismatch ? el("p", { class: "stop", attrs: { role: "alert", "data-mismatch-note": "" } }, say(view.mismatch)) : null;
    if (!view.showRecord) return { note, record: [] };
    const rows = view.rows.flatMap((r) => [
      el("dt", { attrs: { "data-done-row": r.platform } }, r.name),
      el(
        "dd",
        { attrs: { "data-done-row": r.platform, ...(r.mismatch ? { "data-mismatch": "" } : {}) } },
        el("span", { class: r.raw ? "acct raw" : "acct" }, r.account),
        r.kind ? el("span", { class: "kind", attrs: { "data-kind": "" } }, say(r.kind)) : null,
        r.expected ? el("span", { class: "kind", attrs: { "data-expected": "" } }, say(r.expected)) : null,
        r.switchUsed ? el("span", { class: "kind", attrs: { "data-switch-used": "" } }, t.mismatch_switch_used) : null,
        // What the server recorded is not what step 5 said: no sentence in the copy, the code.
        r.mismatch ? el("code", { class: "kind", attrs: { "data-code": "" } }, "kind_mismatch") : null,
      ),
    ]);
    return {
      note,
      record: [
        el("h2", { class: "record-title" }, t.recorded),
        el(
          "div",
          { class: "rec6", attrs: { "data-record": "" } },
          el("p", {}, el("time", {}, view.date)),
          view.record ? el("p", {}, say(view.record)) : null,
          rows.length ? el("dl", { class: "list" }, ...rows) : null,
          el("p", {}, say(view.shortIdLine)),
        ),
      ],
    };
  }

  /** done.open_proof as a link to the card's page, in a sentence (done.hung, hang.look). */
  const openProofIn = (template: string, view: DoneView): (string | HTMLElement)[] =>
    parts(template, { open_proof: COPY.done.open_proof }).map((p) => (p.placeholder === null ? p.text : newTab(view.proofPath, { "data-open-proof": "" }, p.text)));

  /**
   * Step 6: hang the link on the profile (hang.md, part 1). `short`: only
   * whether the link is still there; hang.rehang shows the whole step.
   */
  function hangScreen(view: DoneView, short: boolean): void {
    const t = COPY.done;
    const h = COPY.hang;
    const { note, record } = recordParts(view);
    const linkbox = el("div", { class: "linkbox" }, el("span", { class: "id", attrs: { "data-link": "" } }, view.link));
    // One main button a screen (design/DESIGN.md): hang.copy on the whole step 6, common.next on the short one.
    const toFinish = (): void => finishScreen(view, () => hangScreen(view, short));
    let body: (HTMLElement | null)[];
    if (short) {
      body = [
        el("h1", { class: "hang-title" }, say(view.stillThere!)),
        linkbox,
        el("p", { class: "look" }, ...openProofIn(h.look, view)),
        el("p", { class: "why", attrs: { "data-why-hang": "" } }, say(view.why)),
        actions(secondary(h.rehang, () => hangScreen(view, false)), primary(COPY.common.next, toFinish)),
      ];
    } else {
      const copy = primary(h.copy, () => {
        // The whole https:// address, so that a profile turns it into a link.
        navigator.clipboard.writeText(view.url).then(
          () => replace(copy, t.copied),
          () => undefined,
        );
      });
      const qr = qrSvg(view.hangUrl);
      // The link is written beside it, in the other column: the code is not read out.
      qr.setAttribute("aria-hidden", "true");
      // Under the link: a new card's new link, a withdrawn account's link, the other cards that declare an account.
      const notes = [
        view.newCard ? el("p", { class: "small", attrs: { "data-new-card": "" } }, h.new_card) : null,
        view.withdrawnLink ? el("p", { class: "small", attrs: { "data-withdrawn-link": "" } }, t.withdrawn_link) : null,
        ...view.otherCards.map((oc) => el("p", { class: "small", attrs: { "data-other-cards": "" } }, say(oc))),
      ];
      body = [
        el("h1", { class: "hang-title" }, say(view.hangTitle)),
        el("p", { class: "why", attrs: { "data-why-hang": "" } }, say(view.why)),
        el(
          "div",
          { class: "hang" },
          el("div", { class: "hang-phone" }, el("h3", {}, t.by_phone), el("div", { class: "qr", attrs: { "data-qr": view.hangUrl } }, qr), el("p", { class: "small" }, t.by_phone_scan)),
          el(
            "div",
            { class: "hang-computer" },
            el("h3", {}, t.on_computer),
            linkbox,
            copy,
            // The sentence in one element: a button is a flex box, and each of its children would be an item of its own.
            ...view.profiles.map((pr) => newTab(pr.url, { class: "btn ghost", "data-profile": "" }, el("span", {}, say(pr.text)))),
            el("ol", { class: "hang-steps" }, el("li", {}, t.step_edit), el("li", {}, t.step_link), el("li", {}, t.step_add), el("li", {}, t.step_paste)),
          ),
        ),
        ...notes,
        el("div", { class: "hung" }, el("p", { class: "hung-ask" }, ...openProofIn(t.hung, view)), el("p", {}, t.hung_done)),
        ...record,
        actionsEnd(secondary(COPY.common.next, toFinish)),
      ];
    }
    show(6, el("section", { class: "step", attrs: { "data-step": "hang", "data-short": String(short) } }, note, ...recordedLines(view), ...body));
  }

  /**
   * The last step: done and share; `back` goes to step 6 as it was left.
   * Everything withdrawn: the day, that the links can come down, and
   * nothing else (no back: there was no step 6).
   */
  function finishScreen(view: DoneView, back: (() => void) | null): void {
    const t = COPY.done;
    const f = COPY.finish;
    const result = view.withdrawAll ? "withdraw_all" : view.kindsUnreadable ? "recorded_only" : "list";
    if (view.withdrawAll) {
      const { note, record } = recordParts(view);
      show(
        STEPS,
        el(
          "section",
          { class: "step", attrs: { "data-step": "done", "data-result": result } },
          note,
          el("h1", {}, say(view.title)),
          ...recordedLines(view),
          el("p", { class: "unlink", attrs: { "data-unlink": "" } }, say(view.unlink)),
          ...record,
          actionsEnd(primary(f.done, () => before())),
        ),
      );
      return;
    }
    const card = el(
      "div",
      { class: "cert", attrs: { "data-proof": "" } },
      el("div", { class: "cert-top" }, logo({ animated: true }), el("span", {}, t.proof)),
      ...view.card.map((r) =>
        el(
          "p",
          { class: "cert-row", attrs: { "data-card-row": "" } },
          r.name === null ? null : el("span", { class: "cert-platform", attrs: { "data-card-platform": "" } }, r.name),
          el("span", { class: r.raw ? "acct raw" : "acct", attrs: { "data-card-account": "" } }, r.account),
        ),
      ),
      el("p", { class: "cert-id" }, COPY.confirm.short_id_label, " ", sentence(COPY.confirm.short_id, { short_id: view.shortId })),
    );
    show(
      STEPS,
      el(
        "section",
        { class: "step", attrs: { "data-step": "done", "data-result": result } },
        el("h1", {}, say(view.title)),
        card,
        // The call to share (principles: the one place of a fact page that may move the reader): the card's ordinal when the answer had it.
        el("p", { class: "invite", attrs: { "data-invite": "" } }, view.ordinal ? say(view.ordinal) : null, f.invite),
        el("p", { class: "invite" }, f.thanks),
        el("div", { class: "share" }, ...view.shares.map((sh) => newTab(sh.url, { class: "btn", "data-share": "" }, say(sh.button)))),
        // The web has no reminder: when to come back, in words (the app's step 7).
        el("div", { class: "return", attrs: { "data-return": "" } }, el("h3", {}, t.return_title), el("p", {}, t.return_note)),
        actions(back ? secondary(COPY.common.back, back) : null, secondary(f.done, () => before())),
      ),
    );
  }

  before();
}
