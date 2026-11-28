// The configuration of the measurement's temporary Worker (README.md in this
// directory), made from wrangler.jsonc's test environment each time, so that
// it is the deployed Worker's but for what is listed here:
//
//   - the name `iamreal-measure`, on workers.dev only (no zone: the WAF
//     rules of iamreal.tw do not apply), and no schedule (the CRL mirror
//     never runs, nothing goes to MOICA)
//   - the entry measure-build/index.ts, and no Static Assets (every path
//     runs the Worker)
//   - two buckets of its own, made by the maintainer for the measurement
//   - no per-IP limits (src/rate-limit.ts lets a request through when the
//     binding is not there), and the site-wide limit at the most it can be
//   - the object's name `test-measure`, card proofs stopped and a rebuild
//     named, so that the empty object rebuilds from the made-up proof log
//     when it first starts; the most counts a minute's file holds
//
// Nothing here reads a token or sends a request.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experimental_readRawConfig } from "wrangler";
import { WORKER_DIR } from "../scripts/deploy.ts";

/** The only name a build of measure-build/ is deployed as. */
export const MEASURE_WORKER = "iamreal-measure";

/** The measurement's buckets, made by the maintainer before and deleted after (README.md in this directory). */
export const MEASURE_BUCKETS = { DATA: "iamreal-measure-data", CONNECTION_LOG: "iamreal-measure-logs" } as const;

/** The name the made-up proof log is rebuilt under (README.md, "從證明紀錄重建"). */
export const MEASURE_REBUILD = "measure-1";

type Raw = Record<string, unknown>;

/** wrangler.jsonc, as written. */
const deployedConfig = (): Raw => experimental_readRawConfig({ config: join(WORKER_DIR, "wrangler.jsonc") }).rawConfig as Raw;

/** The names the deployed environments have: a measurement is never deployed as one of them. */
export function deployedNames(): string[] {
  const top = deployedConfig() as { name?: string; env?: Record<string, { name?: string }> };
  return [top.name, ...Object.values(top.env ?? {}).map((e) => e.name)].filter((n): n is string => typeof n === "string");
}

/** The temporary Worker's configuration, a whole one with no environments. */
export function measureConfig(): Raw {
  const top = deployedConfig();
  const test = (top["env"] as Record<string, Raw> | undefined)?.["test"];
  if (test === undefined) throw new Error("wrangler.jsonc has no test environment");
  const vars = { ...(test["vars"] as Record<string, string>) };
  Object.assign(vars, { PROOF_LOG_OBJECT_NAME: "test-measure", CARD_PROOFS_PAUSED: "true", REBUILD_PROOF_LOG: MEASURE_REBUILD, COUNT_EVENTS_PER_MINUTE: "100000", CARD_PROOF_STARTS_PER_MINUTE: "100000" });
  const config: Raw = {
    name: MEASURE_WORKER,
    main: join(WORKER_DIR, "measure-build", "index.ts"),
    compatibility_date: top["compatibility_date"],
    send_metrics: false,
    migrations: top["migrations"],
    limits: top["limits"],
    workers_dev: true,
    preview_urls: false,
    durable_objects: test["durable_objects"],
    r2_buckets: [
      { binding: "DATA", bucket_name: MEASURE_BUCKETS.DATA },
      { binding: "CONNECTION_LOG", bucket_name: MEASURE_BUCKETS.CONNECTION_LOG },
    ],
    vars,
  };
  checkMeasureConfig(config);
  return config;
}

/** Throws unless `config` is the measurement's: its name, its buckets, no schedule, no route. */
export function checkMeasureConfig(config: Raw): void {
  if (config["name"] !== MEASURE_WORKER) throw new Error(`the measurement is deployed as ${MEASURE_WORKER} and no other Worker`);
  // Only if wrangler.jsonc itself were ever to name a deployed environment so.
  for (const name of deployedNames()) if (config["name"] === name) throw new Error(`${name} is a deployed environment's Worker`);
  if (config["env"] !== undefined || config["routes"] !== undefined || config["route"] !== undefined || config["triggers"] !== undefined) throw new Error("the measurement has no environments, routes or schedule");
  const buckets = (config["r2_buckets"] as { bucket_name: string }[]).map((b) => b.bucket_name).sort();
  if (JSON.stringify(buckets) !== JSON.stringify(Object.values(MEASURE_BUCKETS).sort())) throw new Error("the measurement writes to its own buckets and no others");
}

/** Writes the configuration into `dir` as wrangler.json; answers its path. */
export function writeMeasureConfig(dir: string, extraVars: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  const config = measureConfig();
  config["vars"] = { ...(config["vars"] as Record<string, string>), ...extraVars };
  const path = join(dir, "wrangler.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
