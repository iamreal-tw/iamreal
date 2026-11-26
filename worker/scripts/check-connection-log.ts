// Before a deploy: reads back the lifecycle rules of the bucket the
// connection log is written to and checks that what is under
// `connection/` is deleted 31 days after it was written, by one rule and
// no other (ADR-0022: the IP address of a submission is kept 31 days; the
// privacy notice says so, and nothing but this rule makes it true).
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//     node --experimental-strip-types scripts/check-connection-log.ts test
//
// Nothing runs it yet: no workflow and no deploy script calls it
// (README.md, "連線紀錄", says why and what stands in its place). The
// operator can run it by hand. It needs a token that can read the settings
// of R2 buckets; Cloudflare has no permission that reads the settings
// alone, so such a token can also read the objects, the connection log
// among them. This file imports nothing but Node's own modules: what runs
// with that token is this file and Node.
//
// It sends one GET to Cloudflare's API
// (https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/get/)
// and prints the rules' IDs, prefixes and ages; never the token, and
// nothing of the account but the bucket's name.
import { pathToFileURL } from "node:url";

/** The bucket of each environment (wrangler.jsonc, the binding CONNECTION_LOG; test/deploy.test.ts checks they are the same). */
export const CONNECTION_LOG_BUCKETS: Readonly<Record<string, string>> = { test: "iamreal-test-logs" };

/** The prefix the connection log's objects are written under (src/connection-log.ts, `CONNECTION_LOG_PREFIX`; test/deploy.test.ts checks). */
export const PREFIX = "connection/";

/** 31 days, in the seconds a lifecycle rule counts an object's age in. */
export const MAX_AGE_SECONDS = 31 * 24 * 60 * 60;

interface Rule {
  readonly id?: unknown;
  readonly enabled?: unknown;
  readonly conditions?: { readonly prefix?: unknown };
  readonly deleteObjectsTransition?: { readonly condition?: { readonly type?: unknown; readonly maxAge?: unknown; readonly date?: unknown } };
}

/** A rule's prefix: none is every object of the bucket. */
const prefixOf = (rule: Rule): string => (typeof rule.conditions?.prefix === "string" ? rule.conditions.prefix : "");

/** Whether a rule with this prefix reaches any key under `connection/`: the prefix is the beginning of one, or one's beginning. */
const reaches = (prefix: string): boolean => PREFIX.startsWith(prefix) || prefix.startsWith(PREFIX);

/**
 * What is wrong with a bucket's lifecycle rules (the `result.rules` of
 * Cloudflare's answer), or null if they are right: of the enabled rules
 * that delete objects and reach `connection/`, there is exactly one; its
 * prefix is `connection/` or none; it deletes by age, at 31 days. A rule
 * that is not enabled deletes nothing and does not count; a rule that only
 * aborts multipart uploads or moves objects to another storage class
 * deletes no object and does not count either.
 */
export function lifecycleProblem(rules: unknown): string | null {
  if (rules !== undefined && !Array.isArray(rules)) return "the answer's rules are not a list";
  const deleting = ((rules ?? []) as Rule[]).filter((r) => r !== null && typeof r === "object" && r.enabled === true && r.deleteObjectsTransition !== undefined && r.deleteObjectsTransition !== null && reaches(prefixOf(r)));
  if (deleting.length === 0) return `no enabled rule deletes the objects under ${PREFIX}: the connection log would be kept for ever`;
  if (deleting.length > 1) return `${deleting.length} enabled rules delete objects under ${PREFIX} (${deleting.map((r) => JSON.stringify(r.id)).join(", ")}): there must be one, so that there is one answer to how long an object is kept`;
  const rule = deleting[0]!;
  const prefix = prefixOf(rule);
  if (prefix !== PREFIX && prefix !== "") return `the rule ${JSON.stringify(rule.id)} has the prefix ${JSON.stringify(prefix)}: it must be ${JSON.stringify(PREFIX)} or none, so that it covers every object of the connection log`;
  const condition = rule.deleteObjectsTransition!.condition;
  if (condition?.type !== "Age") return `the rule ${JSON.stringify(rule.id)} does not delete by age (its condition is ${JSON.stringify(condition?.type)})`;
  if (condition.maxAge !== MAX_AGE_SECONDS) return `the rule ${JSON.stringify(rule.id)} deletes after ${JSON.stringify(condition.maxAge)} seconds: it must be ${MAX_AGE_SECONDS} (31 days)`;
  return null;
}

/** One line a rule, for the run's log: nothing here is secret. */
export function describeRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return [];
  return (rules as Rule[]).map((r) => {
    const c = r?.deleteObjectsTransition?.condition;
    const deletes = c === undefined ? "deletes nothing" : c.type === "Age" ? `deletes after ${JSON.stringify(c.maxAge)} seconds` : `deletes on ${JSON.stringify(c.type)} ${JSON.stringify(c.date)}`;
    return `rule ${JSON.stringify(r?.id)}: ${r?.enabled === true ? "enabled" : "not enabled"}, prefix ${JSON.stringify(prefixOf(r ?? {}))}, ${deletes}`;
  });
}

/**
 * What to do about an answer that is not the rules, by its HTTP status. The
 * words are for whoever reads the failed run: they say what to check, and
 * hold nothing of the answer's body, which is Cloudflare's to word.
 */
export function refusalOf(status: number, bucket: string): string {
  if (status === 401 || status === 403) {
    return (
      `Cloudflare refused the token (HTTP ${status}). The token of this check must be able to read the settings of R2 buckets in this account: ` +
      'the permission group "Workers R2 Storage Read" (Cloudflare\'s documentation says it can "view bucket configuration"; if that is not enough to read lifecycle rules, ' +
      '"Workers R2 Storage Write" is what it names for managing them). Check that the secret holds that token and that the token has not expired or been revoked.'
    );
  }
  if (status === 404) return `Cloudflare knows no bucket ${JSON.stringify(bucket)} in this account (HTTP 404): the operator makes it, with its lifecycle rule, before the first deploy (worker/README.md, "連線紀錄").`;
  return `Cloudflare answered HTTP ${status} to reading the lifecycle rules of ${JSON.stringify(bucket)}.`;
}

async function main(): Promise<void> {
  const environment = process.argv[2];
  const bucket = environment === undefined ? undefined : CONNECTION_LOG_BUCKETS[environment];
  if (bucket === undefined) throw new Error(`usage: check-connection-log.ts ${Object.keys(CONNECTION_LOG_BUCKETS).join("|")}`);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not both set: the token that can read R2's settings, and the account");
  if (!/^[0-9a-f]{32}$/.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID is not 32 hex digits");

  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/lifecycle`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`Cloudflare's API did not answer: ${e instanceof Error ? e.name : "unknown"}`);
  }
  if (response.status !== 200) throw new Error(refusalOf(response.status, bucket));
  let rules: unknown;
  try {
    rules = ((await response.json()) as { result?: { rules?: unknown } }).result?.rules;
  } catch {
    throw new Error("Cloudflare's answer is not JSON");
  }
  console.log(`the lifecycle rules of ${bucket}:`);
  for (const line of describeRules(rules)) console.log(`  ${line}`);
  const problem = lifecycleProblem(rules);
  if (problem !== null) throw new Error(`${bucket}: ${problem}`);
  console.log(`${bucket}: one enabled rule deletes what is under ${PREFIX} after 31 days`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error(`check-connection-log: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
