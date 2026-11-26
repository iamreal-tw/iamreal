// The browser and the operating system of a count (spec/counts.md,
// "Browsers", "Operating systems"), from a `User-Agent`: the one way both the
// card proof page (web/src/counts.ts, which also reads the versions with
// `browserOf`) and the visitors' pages (worker/site/count.js, written from
// this file by worker/scripts/site-files.ts) name them. Only the names are
// sent; the text itself is not.
//
// This file is also a part of a script that is no module: it imports
// nothing but types, and has nothing but these.
import type { Browser, Os } from "./counts.ts";

/**
 * The browsers a `User-Agent` is told apart by, in the order they are looked
 * for (Edge and Samsung Internet also write `Chrome/`, Chrome writes
 * `Safari/`). The first group is the major version; a browser the table does
 * not name (Opera) is `other`, and has none.
 */
const BROWSER_PATTERNS: readonly (readonly [Browser, RegExp])[] = [
  ["edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ["samsung", /\bSamsungBrowser\/(\d+)/],
  ["other", /\b(?:OPR|Opera)\//],
  ["firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
  ["chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
  ["safari", /\bVersion\/(\d+)[\d.]* .*Safari\//],
];

/** The browser, and the major version its pattern found, if any. */
export function browserOf(userAgent: string): { browser: Browser; major: string | undefined } {
  for (const [browser, re] of BROWSER_PATTERNS) {
    const m = re.exec(userAgent);
    if (m !== null) return { browser, major: m[1] };
  }
  return { browser: "other", major: undefined };
}

/** The browser and the operating system as the table names them, from a `User-Agent`. What it cannot tell is `other`. */
export function familiesOf(userAgent: string): { browser: Browser; os: Os } {
  const has = (re: RegExp): boolean => re.test(userAgent);
  const { browser } = browserOf(userAgent);
  const os: Os = has(/\bAndroid\b/) ? "android" : has(/\b(?:iPhone|iPad|iPod)\b/) ? "ios" : has(/\bWindows NT\b/) ? "windows" : has(/\bCrOS\b/) ? "chromeos" : has(/\bMac OS X\b|\bMacintosh\b/) ? "macos" : has(/\bLinux\b/) ? "linux" : "other";
  return { browser, os };
}
