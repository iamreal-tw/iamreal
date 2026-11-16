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

/** A sentence of the copy with its values; codes in <code>. */
export function sentence(template: string, values: Values = {}): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const p of parts(template, values)) {
    f.appendChild(p.placeholder !== null && CODE_PLACEHOLDERS.has(p.placeholder) ? el("code", {}, p.text) : document.createTextNode(p.text));
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
