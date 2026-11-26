// Small helpers to build the screen with DOM calls (no framework, no
// innerHTML: every value goes in as text).
import { type Values, parts } from "./copy.ts";

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; attrs?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  for (const [k, v] of Object.entries(props.attrs ?? {})) e.setAttribute(k, v);
  append(e, ...children);
  return e;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

/** Placeholders whose values are codes, shown in a code font. */
const CODE_PLACEHOLDERS = new Set(["code", "short_id"]);
/** Placeholders whose values are accounts, shown in the accounts' typeface. */
const ACCOUNT_PLACEHOLDERS = new Set(["account", "last_declared"]);
/** Placeholders whose values are words to heed, in bold ink (confirm.cannot_delete, design/copy/card-proof.md step 5). */
const EMPHASIS_PLACEHOLDERS = new Set(["cannot_delete"]);

/** A sentence of the copy with its values; codes in <code>, accounts in <span class="acct">, words to heed in <strong>. */
export function sentence(template: string, values: Values = {}): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const p of parts(template, values)) {
    if (p.placeholder !== null && CODE_PLACEHOLDERS.has(p.placeholder)) f.appendChild(el("code", {}, p.text));
    else if (p.placeholder !== null && ACCOUNT_PLACEHOLDERS.has(p.placeholder)) f.appendChild(el("span", { class: "acct" }, p.text));
    else if (p.placeholder !== null && EMPHASIS_PLACEHOLDERS.has(p.placeholder)) f.appendChild(el("strong", { class: "heed" }, p.text));
    else f.appendChild(document.createTextNode(p.text));
  }
  return f;
}

export function button(label: Child, onClick: (ev: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const b = el("button", { class: cls, attrs: { type: "button" } }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** Replaces the children of `parent`. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}
