// The frame every screen of the card proof shares (the seven steps): the
// header (the mark, the service's name and the site's, not
// a link) as wide as the site, and the one column the page sits in.
import { COPY } from "./copy.ts";
import { el, replace } from "./dom.ts";
import { logo } from "./logo.ts";

/** Puts the header and `children`, in the column, into `root`. */
export function frame(root: HTMLElement, ...children: HTMLElement[]): void {
  const header = el(
    "header",
    { class: "top" },
    el("div", { class: "bar" }, logo(), el("b", {}, COPY.common.service_name), el("span", { class: "domain", attrs: { "data-site": "" } }, COPY.common.site_name)),
  );
  replace(root, header, el("div", { class: "col" }, ...children));
}
