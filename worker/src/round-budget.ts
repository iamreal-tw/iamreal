// The CPU time one round of the CRL mirror counts on, and how much of it a
// round keeps back before it starts another file. In a file of its own,
// with no import, so that the checks of the configuration read the same
// numbers the Worker is built with (scripts/deploy-build-checks.ts,
// test/environments.test.ts).

/**
 * The CPU time of one invocation: 5 minutes, the most a Worker can be given
 * (https://developers.cloudflare.com/workers/platform/limits/, "CPU time",
 * read on 2026-11-20). It is `limits.cpu_ms` of wrangler.jsonc: without
 * that setting an invocation gets 30 seconds, and the hourly schedule was
 * stopped after about 32 seconds of CPU time, before the first tree was
 * built (README.md, "Cloudflare 上第一次建樹").
 */
export const ROUND_CPU_MS: number = 300_000;

/**
 * What a round keeps back for one more file: 2.5 minutes, for the tree of
 * the largest CRL. MOICA's G2 CRL (341,055 entries on 2026-11-19) took 27
 * to 29 seconds in the local workerd (README.md, "清冊鏡像量到的"). How
 * much longer it takes on Cloudflare is not measured yet; all that is known
 * is that 32 seconds were not enough. So this is five times the local
 * figure, which also leaves room for the CRL to grow.
 */
export const CRL_LARGEST_MS: number = 150_000;

/**
 * For how long a round goes on starting files an earlier round left without
 * a line (src/mirror.ts, `catchUpMs`): until what is left of the CPU time
 * is what is kept back. The round measures it by the clock, from when it
 * begins on the archive. A Worker cannot read its CPU time; from there on
 * the round computes or waits for the bucket, so the CPU time it uses is
 * never more than the clock shows. Before that it only fetches and stores:
 * 72 ms of CPU time on Cloudflare (README.md, "第一次部署量到的").
 */
export const CRL_CATCH_UP_MS: number = ROUND_CPU_MS - CRL_LARGEST_MS;
