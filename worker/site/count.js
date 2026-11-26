// Written by scripts/site-files.ts from protocol/src/families.ts and count/visitor.js: change those, not this file.
"use strict";
(() => {
// The browser and the operating system of a count (spec/counts.md,
// "Browsers", "Operating systems"), from a `User-Agent`: the one way both the
// card proof page (web/src/counts.ts, which also reads the versions with
// `browserOf`) and the visitors' pages (worker/site/count.js, written from
// this file by worker/scripts/site-files.ts) name them. Only the names are
// sent; the text itself is not.
//
// This file is also a part of a script that is no module: it imports
// nothing but types, and has nothing but these.

/**
 * The browsers a `User-Agent` is told apart by, in the order they are looked
 * for (Edge and Samsung Internet also write `Chrome/`, Chrome writes
 * `Safari/`). The first group is the major version; a browser the table does
 * not name (Opera) is `other`, and has none.
 */
const BROWSER_PATTERNS                                          = [
  ["edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ["samsung", /\bSamsungBrowser\/(\d+)/],
  ["other", /\b(?:OPR|Opera)\//],
  ["firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
  ["chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
  ["safari", /\bVersion\/(\d+)[\d.]* .*Safari\//],
];

/** The browser, and the major version its pattern found, if any. */
function browserOf(userAgent        )                                                  {
  for (const [browser, re] of BROWSER_PATTERNS) {
    const m = re.exec(userAgent);
    if (m !== null) return { browser, major: m[1] };
  }
  return { browser: "other", major: undefined };
}

/** The browser and the operating system as the table names them, from a `User-Agent`. What it cannot tell is `other`. */
function familiesOf(userAgent        )                               {
  const has = (re        )          => re.test(userAgent);
  const { browser } = browserOf(userAgent);
  const os     = has(/\bAndroid\b/) ? "android" : has(/\b(?:iPhone|iPad|iPod)\b/) ? "ios" : has(/\bWindows NT\b/) ? "windows" : has(/\bCrOS\b/) ? "chromeos" : has(/\bMac OS X\b|\bMacintosh\b/) ? "macos" : has(/\bLinux\b/) ? "linux" : "other";
  return { browser, os };
}

// From protocol/src/counts.ts: where the visit ID is kept in sessionStorage, and the forms of an ID and of a source.
const VISIT_ID_KEY = "iamreal.visit_id";
const COUNT_ID = /^[0-9a-f]{32}$/;
const SOURCE = /^[a-z0-9.-]{1,253}$/;

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
})();
