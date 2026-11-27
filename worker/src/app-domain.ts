// The app domain (ADR-0040; GLOSSARY.md, "app 網域"; README.md, "app 網域"):
// a second custom domain of the same Worker, whose every address opens the
// phone apps. A phone's system reads two files from it to know which apps may
// open it: Android's App Links /.well-known/assetlinks.json, iOS's Universal
// Links /.well-known/apple-app-site-association. Both are made from the
// environment's setting `APP_DOMAIN` (wrangler.jsonc; app-domain-setting.ts), never kept as files:
// Static Assets would send a file on every domain of the Worker, the test
// site's too.
//
//   /.well-known/assetlinks.json                 the apps and their signing keys
//   /.well-known/apple-app-site-association      the apps, by team and identifier
//   anything else under /.well-known/            404
//   anything else, with any query                the page for a phone without
//                                                the app (design/copy/app-domain.md)
//
// The apps read nothing of the address (#92): every path opens them alike,
// so every path is the same page. Nothing here asks the proof log or any other
// object, writes anything or counts anything. The files of Static Assets
// (wrangler.jsonc, "assets") are sent on this domain too, as on any other,
// without the Worker: the page's style sheet, typeface and icon are among
// them.
import { type AppDomain, appDomainProblem, appleAppSiteAssociation, assetLinks } from "./app-domain-setting.ts";
import { EVERY_RESPONSE, TEST_SITE_HEADERS, VISITOR_HEADERS } from "./headers.ts";
import { noAppPage } from "./pages/no-app.ts";
import { proofLogSettingsOf } from "./settings.ts";

/** The setting as it is, or undefined for none (absent, or null). */
const settingOf = (env: Env): unknown => (env as { APP_DOMAIN?: unknown }).APP_DOMAIN ?? undefined;

/**
 * Whether a request to `hostname` is for the app domain: the setting names
 * that host. Read before the setting's form is checked, so that a setting
 * that is wrong takes down the app domain only, never the site.
 */
export function isAppDomainHost(env: Env, hostname: string): boolean {
  const setting = settingOf(env);
  return typeof setting === "object" && setting !== null && (setting as { host?: unknown }).host === hostname;
}

/** How long a cache may keep what the app domain answers: an hour. Apple's CDN and a phone keep the files longer by themselves. */
export const APP_DOMAIN_CACHE = "public, max-age=3600";

/**
 * Answers a request to the app domain (`isAppDomainHost`). The test log's
 * site says noindex here too. A setting that is not right answers 500 and
 * says so in one line, with nothing of the request.
 */
export function appDomain(request: Request, env: Env): Response {
  const { pathname } = new URL(request.url);
  let site: { testProofLogClearedOn: string | null; host: string };
  let d: AppDomain;
  try {
    const setting = settingOf(env);
    const problem = appDomainProblem(setting);
    if (problem !== null) throw new Error(problem);
    d = setting as AppDomain;
    const settings = proofLogSettingsOf(env);
    site = { testProofLogClearedOn: settings.testProofLogClearedOn, host: settings.siteHost };
    // The production log's app domain is made at launch (design/copy/app-domain.md); a deploy build's check keeps it out until then.
    if (site.testProofLogClearedOn === null) throw new Error("the production log's app domain has no page yet");
  } catch (e) {
    console.error(JSON.stringify({ event: "internal_error", page: "app_domain", where: "settings", error: e instanceof Error ? e.name : "unknown" }));
    return new Response("internal error\n", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...EVERY_RESPONSE } });
  }
  const test = site.testProofLogClearedOn !== null ? TEST_SITE_HEADERS : {};
  const answer = (status: number, headers: Record<string, string>, body: string): Response =>
    new Response(request.method === "HEAD" ? null : body, { status, headers: { ...headers, ...EVERY_RESPONSE, ...test } });
  if (request.method !== "GET" && request.method !== "HEAD") return answer(405, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Allow: "GET, HEAD" }, "method not allowed\n");
  const json = (body: string): Response => answer(200, { "Content-Type": "application/json", "Cache-Control": APP_DOMAIN_CACHE }, body);
  if (pathname === "/.well-known/assetlinks.json") return json(assetLinks(d));
  if (pathname === "/.well-known/apple-app-site-association") return json(appleAppSiteAssociation(d));
  if (pathname === "/.well-known" || pathname.startsWith("/.well-known/")) return answer(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": APP_DOMAIN_CACHE }, "not found\n");
  return answer(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": APP_DOMAIN_CACHE, ...VISITOR_HEADERS }, noAppPage(site));
}
