// The response headers the headless browser tests expect the card proof page
// to come with, and serve it with where a test serves the page itself. The
// Content-Security-Policy is the one README.md asks the server to send: the
// page may connect to its own origin and to its proof log's data domain, so
// the production log's site and the test log's differ in that one
// address. The tests check that README.md quotes both exactly.

const policy = (dataOrigin: string): string =>
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ${dataOrigin}; ` +
  "img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The production log's site (iamreal.tw). */
export const CONTENT_SECURITY_POLICY = policy("https://data.iamreal.tw");

/** The test log's site (test.iamreal.tw), `pnpm local`, and the Worker the tests run in the local workerd, which is set up as that site. */
export const TEST_SITE_CONTENT_SECURITY_POLICY = policy("https://test-data.iamreal.tw");

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
