// The screens of a card proof (design/copy/card-proof.md): six steps, one
// screen each: before you start, read the card, the PIN, your accounts,
// confirm (and in progress), done. There is no screen to pick a platform:
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
// accounts.preview opens the account's page on the platform in a new tab
// (window.open with noopener and noreferrer): the only place steps 1 to 5
// send the cardholder elsewhere. They have no link to another page
// (docs/design/principles.md, principle 1), but for the one written after
// a stop that the cardholder cannot get past on this page (links.prepare,
// after stops.component_unreachable). The new tab gets the account typed and nothing
// else; this page loads nothing from the platform.
//
// Every sentence comes from copy.ts; the platforms, their display names and
// formats from the server's table (the engine's CardStatus); each
// platform's prefix, hint and address from src/platforms.ts. ids and data-*
// attributes are for the headless browser test and hold no value.
import { type CardProofFlow, type CardStatus, type Consequence, type Done, FlowStop, type Progress, type Prover, type Stop, createCardProof, presentationOf } from "../index.ts";
import { BASE } from "../base.ts";
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
  accountsView,
  beforeView,
  confirmView,
  doneView,
  firstNotDone,
  itemStates,
  onePlatform,
  progressButtons,
  readItemOf,
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

/** The six steps (card-proof.md). */
const STEPS = 6;


function helpLink(topic: HelpTopic): HTMLAnchorElement {
  // A new tab: leaving this page would end the card proof.
  return el("a", { attrs: { href: `${BASE}help.html?topic=${topic}`, target: "_blank", rel: "noopener noreferrer", "data-help": topic } }, COPY.links[topic]);
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

  /** Puts a screen up: the mark, the service's name and the site's; where in the six steps; the screen. */
  function show(step: number, screen: HTMLElement): void {
    const where = el(
      "div",
      { class: "where", attrs: { "data-where": String(step) } },
      el("p", { class: "count" }, fill(COPY.common.step, { step, steps: STEPS })),
      el("span", { class: "bar", attrs: { "aria-hidden": "true" } }, ...Array.from({ length: STEPS }, (_, i) => el("i", { class: i < step ? "on" : "" }))),
    );
    const header = el("header", { class: "top" }, el("div", { class: "bar" }, logo(), el("b", {}, COPY.common.service_name), el("span", { class: "domain", attrs: { "data-site": "" } }, COPY.common.site_name)));
    replace(root, header, el("div", { class: "col" }, where, screen));
    document.title = screen.querySelector("h1")?.textContent ?? "";
    window.scrollTo(0, 0);
  }

  function newFlow(): CardProofFlow {
    flow?.cancel();
    const f = createCardProof({
      card,
      prover: o.prover,
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
        // As plain to see as the two lines above, not in a question to open: it may change whether to go on, and cannot be undone.
        // By the platforms the device knows (there is no platform table yet): one, named; or more than one, and that their accounts are listed together.
        el("p", { class: "lead", attrs: { "data-one-proof": "" } }, say(view.oneProof)),
        view.listedTogether ? el("p", { class: "lead", attrs: { "data-listed-together": "" } }, c.listed_together) : null,
        actionsEnd(primary(COPY.common.next, () => read())),
        el(
          "div",
          { class: "asks" },
          faq(c.why_physical, c.why_physical_card, c.why_physical_mobile),
          // The page sends no one elsewhere but to the account's preview: MOICA's page is named, not linked.
          faq(c.how_to_get, c.how_to_get_counter, c.how_to_get_moica),
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
      f.confirmCard(value).then(
        (status) => flow === f && accounts(f, status),
        (e) => {
          if (flow !== f) return;
          card.release();
          replace(working);
          back.disabled = false;
          message.show(stopMessage(stopOf(e)));
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
        el("ul", { class: "facts" }, el("li", {}, c.purpose), el("li", {}, c.stays), el("li", {}, c.card_and_pin)),
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
   * Step 4: the card's list, one row per platform of the server's table that
   * the card's state has an entry for, and a row that cannot be changed for
   * each account on a platform the device does not know. The cardholder
   * edits the list in place: nothing changed is card proof again, a row
   * filled is a new declaration, a row changed a switch, a row emptied a
   * withdrawal. `typed`: what the rows held when step 5 went back here.
   */
  function accounts(f: CardProofFlow, status: CardStatus, typed: Readonly<Record<string, string>> | null = null): void {
    // Step 3, with the name, is taken down here.
    const a = COPY.accounts;
    const view = accountsView(status);
    const message = messageArea();
    const fields = new Map<string, { input: HTMLInputElement; why: HTMLElement }>();

    const rowNodes = view.rows.map((r) => {
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
      input.value = typed?.[r.platform] ?? r.current;
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") next();
      });
      fields.set(r.platform, { input, why });
      const preview = r.preview
        ? secondary(a.preview, () => {
            const u = valid(r.platform);
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
    });

    /** The account typed on a row, tidied (presentationOf); "" for none. Shows the format hint under the row and returns null if it is not in the format. */
    function valid(platform: string): string | null {
      const field = fields.get(platform)!;
      const slot = status.slots.find((sl) => sl.platform === platform)!;
      const u = presentationOf(platform)!.normalize(field.input.value);
      if (u === "" || slot.row!.format.accepts(u)) {
        replace(field.why);
        return u;
      }
      showUnder(platform, stopMessage({ code: "username", platform }));
      return null;
    }

    function showUnder(platform: string, m: Message): void {
      const field = fields.get(platform);
      if (field) replace(field.why, ...messageNodes(m));
      else message.show(m);
    }

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
      let cq: Consequence;
      try {
        cq = f.choose(entries);
      } catch (e) {
        if (flow !== f) return; // the wait ran out: step 1 is on screen already
        if (retryable(f, e)) {
          const stop = e.stop;
          // A row's problem under the row; the list's (empty, 3 today) under the list.
          if ((stop.code === "username" || stop.code === "blocked") && stop.platform) return showUnder(stop.platform, stopMessage(stop));
          return message.show(stopMessage(stop));
        }
        return before(stopMessage(stopOf(e)));
      }
      confirmScreen(f, cq, () => goBack(f, (st) => accounts(f, st, entries)));
    }

    const notes = view.notes.length ? el("div", { class: "tips" }, ...view.notes.map((n) => el("p", {}, ...n.map((x) => say(x))))) : null;
    const body: (HTMLElement | null)[] = view.dailyLimit
      ? // 3 records of the card today: the list as it is, then this sentence and "back to the beginning" (which drops the PIN, as cancel does).
        [el("p", { class: "stop", attrs: { "data-daily-limit": "" } }, say(view.dailyLimit)), actions(secondary(a.restart, () => before()))]
      : [
          notes,
          message.node,
          actionsEnd(primary(COPY.common.next, next)),
          view.notYours ? el("p", { class: "not-yours", attrs: { "data-not-yours": "" } }, say(view.notYours)) : null,
          cancel(),
        ];
    const lead = view.lead.map((line, i) => el("p", { class: i === 0 ? "status" : "", attrs: i === 0 ? { "data-status": "" } : { "data-fact": "" } }, ...line.flatMap((m) => messageNodes(m))));
    show(
      4,
      el(
        "section",
        { class: "step", attrs: { "data-step": "accounts", "data-state": view.dailyLimit ? "daily_limit" : view.state } },
        el("h1", {}, say(view.title)),
        ...lead,
        el("div", { class: "acctlist", attrs: { "data-list": "accounts" } }, ...rowNodes),
        ...body,
      ),
    );
    queueMicrotask(() => [...fields.values()][0]?.input.focus());
  }

  /** Back from step 5: the engine first, then step 4 with the rows as they were typed. */
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
    const view = confirmView(cq, single);
    const message = messageArea();
    const go = primary(view.button, () => {
      // The component's window for the second signature opens now, in the click.
      if (!card.open()) {
        // Nothing was sent; the PIN stays where it was (the engine, until the wait runs out).
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
        // As plain to see as the list, above the buttons, apart from the two points below.
        view.listedTogether ? el("p", { class: "public", attrs: { "data-listed-together": "" } }, c.listed_together) : null,
        view.listedSingle ? el("p", { class: "public", attrs: { "data-listed-single": "" } }, say(view.listedSingle)) : null,
        el("ul", { class: "facts" }, el("li", {}, c.no_identity), el("li", {}, view.later)),
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
    show(5, el("section", { class: "step", attrs: { "data-step": "progress" } }, el("h1", {}, c.title), el("p", { class: "lead" }, c.keep_open), list.node, buttons));
    finish(f.proceed(cq.accounts));
  }

  // Step 6: done -----------------------------------------------------------------------

  function doneScreen(d: Done, single: string | null): void {
    const t = COPY.done;
    flow = null;
    const view = doneView(d, single);
    const mine: (HTMLElement | null)[] = [];
    if (!view.withdrawAll) {
      const copy = primary(t.copy, () => {
        // The whole https:// address, so that a profile turns it into a link.
        navigator.clipboard.writeText(view.url).then(
          () => replace(copy, t.copied),
          () => undefined,
        );
      });
      mine.push(
        el(
          "div",
          { class: "cert", attrs: { "data-proof": "" } },
          el("div", { class: "cert-top" }, el("span", {}, t.proof)),
          el("dl", { class: "list" }, ...view.card.flatMap((r) => [el("dt", {}, r.name), el("dd", { class: r.raw ? "acct raw" : "acct", attrs: { "data-card-account": "" } }, r.account)])),
          el("dl", {}, el("dt", {}, COPY.confirm.date), el("dd", {}, el("time", {}, view.date)), el("dt", {}, COPY.confirm.short_id_label), el("dd", {}, sentence(COPY.confirm.short_id, { short_id: view.shortId }))),
          el("p", { class: "hand cert-note" }, t.hand_ai, el("br"), t.hand_profile),
        ),
        el("h2", { class: "put-up" }, t.put_up),
        el("p", { attrs: { "data-put-link": "" } }, say(view.putLink)),
        el("div", { class: "linkbox" }, el("span", { class: "id", attrs: { "data-link": "" } }, view.link), copy),
        view.newCard ? el("p", { class: "small", attrs: { "data-new-card": "" } }, t.new_card) : null,
        view.withdrawnLink ? el("p", { class: "small", attrs: { "data-withdrawn-link": "" } }, t.withdrawn_link) : null,
        el("p", { class: "small" }, helpLink("proof")),
      );
    }
    const recordRows = view.rows.flatMap((r) => [
      el("dt", { attrs: { "data-done-row": r.platform } }, r.name),
      el(
        "dd",
        { attrs: { "data-done-row": r.platform, ...(r.mismatch ? { "data-mismatch": "" } : {}) } },
        el("span", { class: r.raw ? "acct raw" : "acct" }, r.account),
        r.kind ? el("span", { class: "kind", attrs: { "data-kind": "" } }, say(r.kind)) : null,
        // What the server recorded is not what step 5 said: no sentence in the copy, the code.
        r.expected ? el("span", { class: "kind", attrs: { "data-expected": "" } }, say(r.expected)) : null,
        r.switchUsed ? el("span", { class: "kind", attrs: { "data-switch-used": "" } }, COPY.done.mismatch_switch_used) : null,
        r.mismatch ? el("code", { class: "kind", attrs: { "data-code": "" } }, "kind_mismatch") : null,
      ),
    ]);
    show(
      6,
      el(
        "section",
        { class: "step", attrs: { "data-step": "done", "data-result": view.withdrawAll ? "withdraw_all" : d.kinds === null ? "recorded_only" : "list" } },
        // What the proof log recorded is not what step 5 said: first of all, above the title.
        view.mismatch ? el("p", { class: "stop", attrs: { role: "alert", "data-mismatch-note": "" } }, say(view.mismatch)) : null,
        view.withdrawAll ? null : el("div", { class: "hero" }, logo({ animated: true })),
        el("h1", {}, say(view.title)),
        ...mine,
        el("h2", {}, t.recorded),
        el(
          "div",
          { class: "rec6", attrs: { "data-record": "" } },
          el("p", {}, el("time", {}, view.date)),
          view.record ? el("p", {}, say(view.record)) : null,
          view.kindsUnreadable ? el("p", { attrs: { "data-kinds-unreadable": "" } }, t.kinds_unreadable) : null,
          recordRows.length ? el("dl", { class: "list" }, ...recordRows) : null,
          view.kindsUnreadable ? null : el("p", {}, say(view.shortIdLine)),
        ),
        ...view.otherCards.map((oc) => el("p", { class: "small", attrs: { "data-other-cards": "" } }, say(oc))),
        el(
          "ul",
          { class: "three ink" },
          view.withdrawAll ? null : el("li", {}, say(view.advice)),
          // A list that is not empty: the proof log records names, and an old name may be taken by someone else.
          view.withdrawAll ? null : el("li", { attrs: { "data-renamed": "" } }, t.renamed),
          el("li", {}, t.trust, " ", helpLink("verify")),
        ),
        el("p", {}, t.unplug),
        // Another card proof, with the same engine (ADR-0013).
        actions(secondary(t.restart, () => before())),
      ),
    );
  }

  before();
}
