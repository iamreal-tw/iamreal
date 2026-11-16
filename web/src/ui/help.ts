// The help pages the screens link to ("how to prepare", "learn more", "how
// to re-verify"). Their content is not written yet: each shows its title,
// and the marker that the content is pending.
import "./style.css";
import { COPY } from "./copy.ts";
import { el, replace } from "./dom.ts";
import { logo } from "./logo.ts";

const topic = new URLSearchParams(location.search).get("topic");
const titles: Record<string, string> = COPY.links;
const title = topic !== null && Object.hasOwn(titles, topic) ? titles[topic]! : null;
if (title !== null) {
  document.title = title;
  replace(
    document.getElementById("app")!,
    el("header", { class: "top" }, logo()),
    el("section", { class: "step", attrs: { "data-help": topic! } }, el("h1", {}, title), el("p", {}, COPY.not_in_card_proof_md.help_pending)),
  );
}
