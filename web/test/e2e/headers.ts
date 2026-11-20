// The response headers the headless browser test serves the page with. The
// Content-Security-Policy is the one README.md asks the server to send; the
// test checks that README.md quotes it exactly.

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://data.iamreal.tw; " +
  "img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Cross-origin isolation for multithreaded proving in Chromium. Unlike COOP
 * `same-origin`, it leaves the page able to talk to the window of MOICA's
 * component.
 */
export const ISOLATION_HEADERS: Record<string, string> = { "Document-Isolation-Policy": "isolate-and-credentialless" };

/**
 * A page that opened this one (window.open) loses its hold on it; the
 * windows this page opens itself (the component's) keep theirs, so the
 * component can still post its reply (README.md, "Cross-Origin-Opener-Policy").
 */
export const OPENER_HEADERS: Record<string, string> = { "Cross-Origin-Opener-Policy": "same-origin-allow-popups" };
