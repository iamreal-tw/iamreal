// The counts of a visitor's page (spec/counts.md; ADR-0032, ADR-0039). It is
// the last part of site/count.js: scripts/site-files.ts writes that file
// from protocol/src/families.ts, with its types taken off, three values of
// protocol/src/counts.ts (the visit ID's key `VISIT_ID_KEY`, the forms of an
// ID `COUNT_ID` and of a source `SOURCE`), and this one. So the browser and
// the operating system are named here as the card proof page names them
// (`familiesOf`), and the forms are the server's.
//
// Every visitor's page the Worker makes loads it, with which page it is on
// the <script> element (`data-page`, and on the page of a card
// `data-short-id`): the HTML is the same for everyone. One request to
// `POST /api/v1/counts` for each count, whose answer nobody reads:
//
// - once, as the page opens: which page, the short ID on the page of a card,
//   and the domain of the `Referer` it was opened with (`source`). Not the
//   rest of the `Referer`, and nothing of the page's own address. A page the
//   browser shows again from its back-forward cache is not opened again.
// - when an element marked `data-count` is pressed: that action, and on the
//   page of a card its short ID.
//
// Every count carries the visit ID, the two names of the browser and the
// operating system, and nothing else. The visit ID is 16 random bytes kept
// in the tab's sessionStorage: it is gone when the tab is closed, and the
// card proof page takes it away when it opens, so a page shown after a card
// proof makes a new one. This script never reads the card proof device ID.
// Do Not Track and Global Privacy Control change nothing (ADR-0032).
//
// The page is whole without this script, and nothing waits for it: a
// request that fails is not sent again.
const tag = document.currentScript;
const page = tag === null ? undefined : tag.dataset.page;
const shortId = tag === null ? undefined : tag.dataset.shortId;
const { browser, os } = familiesOf(navigator.userAgent);

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
/** For a tab whose sessionStorage cannot be used: one ID while the page is open. */
let pageId = null;
/** The tab's visit ID: read each time, as the card proof page may have taken it away while this page was kept. */
const visitId = () => {
  try {
    const kept = sessionStorage.getItem(VISIT_ID_KEY);
    if (kept !== null && COUNT_ID.test(kept)) return kept;
    const made = newId();
    sessionStorage.setItem(VISIT_ID_KEY, made);
    return made;
  } catch {
    return (pageId ??= newId());
  }
};

/** The domain of the `Referer` this page was opened with, if it is written as spec/counts.md has a source. */
const source = (() => {
  try {
    const host = new URL(document.referrer).hostname;
    return SOURCE.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
})();

const send = (members) => {
  try {
    const body = JSON.stringify({ client: "web", ...members, ...(shortId !== undefined && { short_id: shortId }), visit_id: visitId(), browser, os });
    fetch("/api/v1/counts", { method: "POST", body, headers: { "Content-Type": "application/json" }, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", keepalive: true })
      .then((res) => res.body?.cancel())
      .catch(() => {});
  } catch {
    // A count that cannot be made is not sent.
  }
};

if (page !== undefined) {
  send({ event: "page", page, ...(source !== undefined && { source }) });
  addEventListener(
    "click",
    (event) => {
      const marked = event.target instanceof Element ? event.target.closest("[data-count]") : null;
      if (marked !== null) send({ event: "action", action: marked.dataset.count });
    },
    true,
  );
}
