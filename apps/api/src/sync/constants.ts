/**
 * Pagination + windowing constants for the corpus sync engine.
 */

export const MAX_PAGES = 500;
/**
 * Repos synced per cron tick. Capped at 20 to stay under the Workers Free
 * 50-subrequest/invocation budget: a FULL reconcile (#80, since=null) costs
 * ~1 subrequest per issue page, and the largest repo (roxabi-factory, ~1k
 * issues) alone is ~11 pages — so a single run cannot reconcile all repos.
 */
export const WINDOW = 20;
/** Bootstrap: one full-reconcile repo per waitUntil (stays under 50-subreq cap). */
export const BOOTSTRAP_WINDOW = 1;
/**
 * Rotation slots. Coverage ceiling = WINDOW * NUM_SLOTS = 40 repos; with the
 * daily cron each repo is full-reconciled every NUM_SLOTS days (= 2). 36 repos
 * today → fits in 2 slots, no wasted tick. Beyond 40 repos, raise this / WINDOW
 * (watch the subreq budget) or migrate to the dormant Queues fan-out (wrangler.toml).
 */
export const NUM_SLOTS = 2;
