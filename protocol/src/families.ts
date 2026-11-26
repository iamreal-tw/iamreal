// The browser and the operating system of a count (spec/counts.md,
// "Browsers", "Operating systems"), from a `User-Agent`: the one way both the
// card proof page (web/src/counts.ts) and the visitors' pages
// (worker/site/count.js, written from this file by
// worker/scripts/site-files.ts) name them. Only the two names are sent; the
// text itself is not.
//
// This file is also a part of a script that is no module: it imports
// nothing but types, and has nothing but this one function.
import type { Browser, Os } from "./counts.ts";

/** The browser and the operating system as the table names them, from a `User-Agent`. What it cannot tell is `other`. */
export function familiesOf(userAgent: string): { browser: Browser; os: Os } {
  const has = (re: RegExp): boolean => re.test(userAgent);
  const browser: Browser = has(/\bEdg(?:e|A|iOS)?\//)
    ? "edge"
    : has(/\bSamsungBrowser\//)
      ? "samsung"
      : has(/\b(?:OPR|Opera)\//)
        ? "other"
        : has(/\b(?:Firefox|FxiOS)\//)
          ? "firefox"
          : has(/\b(?:Chrome|CriOS)\//)
            ? "chrome"
            : has(/\bVersion\/[\d.]+ .*Safari\//)
              ? "safari"
              : "other";
  const os: Os = has(/\bAndroid\b/) ? "android" : has(/\b(?:iPhone|iPad|iPod)\b/) ? "ios" : has(/\bWindows NT\b/) ? "windows" : has(/\bCrOS\b/) ? "chromeos" : has(/\bMac OS X\b|\bMacintosh\b/) ? "macos" : has(/\bLinux\b/) ? "linux" : "other";
  return { browser, os };
}
