// The setting of the app domain (`APP_DOMAIN`, wrangler.jsonc) and the two
// files a phone's system reads from it, made from that setting: what the
// Worker sends on the app domain (src/app-domain.ts) and what the check of a
// deploy build reads (scripts/deploy-build-checks.ts, `checkAppDomains`). Nothing
// here reads the environment.

/** One app that opens the app domain. */
export interface AppDomainApp {
  /** The app's identifier, the same on Android and iOS (ADR-0040). */
  readonly id: string;
  /** The SHA-256 of its signing keys on Android, `AA:BB:…` in uppercase; none for an app not on Google Play yet, which assetlinks.json then leaves out. */
  readonly android_sha256: readonly string[];
}

/** The setting `APP_DOMAIN`, as wrangler.jsonc writes it. */
export interface AppDomain {
  /** The domain, e.g. `test-app.iamreal.tw`. */
  readonly host: string;
  /** The team of the Apple developer account. */
  readonly apple_team_id: string;
  readonly apps: readonly AppDomainApp[];
}

/** A SHA-256 as Play Console shows a signing key's: 32 bytes in uppercase hex, colons between them. */
const SHA256_FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
/** An Apple team ID: ten uppercase letters and digits. */
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
/** An app's identifier: reverse-DNS, lowercase. */
const APP_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
/** A domain name: lowercase labels, nothing else (no port, no path). */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).sort().join() === [...keys].sort().join();

/**
 * What is wrong with the setting's form, or null: the keys of `AppDomain` and
 * no other, a domain name, a team ID, apps with identifiers, each once, and
 * fingerprints, each once. Which domain and which apps are the check of a
 * deploy build's to say (scripts/deploy-build-checks.ts, `checkAppDomains`).
 */
export function appDomainProblem(value: unknown): string | null {
  if (!isObject(value) || !hasKeys(value, ["host", "apple_team_id", "apps"])) return "APP_DOMAIN is not an object of host, apple_team_id and apps";
  if (typeof value.host !== "string" || !HOST.test(value.host)) return "APP_DOMAIN.host is not a domain name";
  if (typeof value.apple_team_id !== "string" || !APPLE_TEAM_ID.test(value.apple_team_id)) return "APP_DOMAIN.apple_team_id is not a team ID";
  if (!Array.isArray(value.apps) || value.apps.length === 0) return "APP_DOMAIN.apps is not a list of apps";
  const ids = new Set<string>();
  for (const app of value.apps as unknown[]) {
    if (!isObject(app) || !hasKeys(app, ["id", "android_sha256"])) return "an app of APP_DOMAIN is not an object of id and android_sha256";
    if (typeof app.id !== "string" || !APP_ID.test(app.id)) return "an app of APP_DOMAIN has no identifier";
    if (ids.has(app.id)) return `${app.id} is in APP_DOMAIN twice`;
    ids.add(app.id);
    const keys = app.android_sha256;
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string" && SHA256_FINGERPRINT.test(k))) return `android_sha256 of ${app.id} is not a list of SHA-256 fingerprints`;
    if (new Set(keys).size !== keys.length) return `android_sha256 of ${app.id} has a fingerprint twice`;
  }
  return null;
}

/** assetlinks.json: one statement for each app with a signing key on Google Play (https://developer.android.com/training/app-links/configure-assetlinks). */
export function assetLinks(d: AppDomain): string {
  return JSON.stringify(
    d.apps
      .filter((app) => app.android_sha256.length > 0)
      .map((app) => ({ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: app.id, sha256_cert_fingerprints: app.android_sha256 } })),
  );
}

/**
 * apple-app-site-association: every app, by team and identifier, opens every
 * path, with any query (https://developer.apple.com/documentation/bundleresources/applinks).
 */
export function appleAppSiteAssociation(d: AppDomain): string {
  return JSON.stringify({ applinks: { details: [{ appIDs: d.apps.map((app) => `${d.apple_team_id}.${app.id}`), components: [{ "/": "*" }] }] } });
}
