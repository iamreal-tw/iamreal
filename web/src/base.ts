// The path the page and its files are served under: the build's `base`
// (vite.config.ts). The card proof page is at /proof and its files under
// /proof/ (worker/README.md, "Static Assets"); the engine's own test page (mode "engine") is
// at /. In Node (the tests) there is no build, and so no import.meta.env:
// "/". Always starts and ends with "/".
export const BASE: string = import.meta.env?.BASE_URL ?? "/";
