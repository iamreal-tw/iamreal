// The CPU time one round of the CRL mirror counts on, and how much of it a
// round keeps back before it starts another file. This file imports
// nothing (test/layout.test.ts), so that the checks of the configuration,
// which run in Node, read the same numbers the Worker is built with
// (scripts/deploy-build-checks.ts, test/environments.test.ts).

/**
 * The CPU time a round counts on for one invocation: 300,000 ms, which is
 * what `limits.cpu_ms` of wrangler.jsonc is set to, the most it can be set
 * to. What is known about the limit of the hourly schedule, on 2026-11-20:
 *
 * - Cloudflare's page of limits
 *   (https://developers.cloudflare.com/workers/platform/limits/, "CPU
 *   time") gives 30 seconds by default, up to 5 minutes with
 *   `limits.cpu_ms`; and in the row of Cron Triggers, 15 minutes for
 *   intervals of an hour or more.
 * - Seen: without the setting, the hourly schedule was stopped after about
 *   32 seconds of CPU time, before the first tree was built (README.md,
 *   "Cloudflare 上第一次建樹"). That does not fit the 15 minutes.
 * - Not measured yet: how much the schedule gets with the setting.
 *
 * So a round counts on no more than what is set.
 */
export const ROUND_CPU_MS: number = 300_000;

/**
 * What a round keeps back for one more file: 2.5 minutes, for the tree of
 * the largest CRL. MOICA's G2 CRL (341,055 entries on 2026-11-19) took 27
 * to 29 seconds in the local workerd (README.md, "清冊鏡像量到的"). How
 * much longer it takes on Cloudflare is not measured yet; all that is known
 * is that 32 seconds were not enough. So this is five times the local
 * figure, which also leaves room for the CRL to grow. The CRL patches a
 * round writes after its lines, its own files' and the last one it starts,
 * take at most 0.2 seconds each in Node (README.md, "清冊差異檔量到的"):
 * they fit in what is left over.
 */
export const RESERVED_FOR_LARGEST_CRL_MS: number = 150_000;

/**
 * For how long a round goes on starting files an earlier round left without
 * a line, and CRL patches of pairs that have none (src/mirror.ts,
 * `catchUpMs`): until what is left of the CPU time is what is kept back.
 * The round measures it by the clock, from when it begins on the archive. A
 * Worker cannot read its CPU time; from there on the round computes or
 * waits for the bucket, so the CPU time it uses is never more than the time
 * that has passed. Before that it only fetches
 * and stores: 72 ms of CPU time on Cloudflare (README.md, "第一次部署量到的").
 *
 * This holds only if the clock shows the time that has passed, and on
 * Cloudflare it does so only right after I/O: it stands still while code
 * runs. The round therefore makes a request to the bucket each time before
 * it reads the clock for this (src/mirror.ts, `elapsedMs`). Reading the
 * clock anywhere else, after computing, would make this limit do nothing,
 * without a test failing: in the local workerd the clock always advances.
 */
export const CRL_CATCH_UP_MS: number = ROUND_CPU_MS - RESERVED_FOR_LARGEST_CRL_MS;
