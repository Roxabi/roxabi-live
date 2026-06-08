// Shared Worker types. D1Database / Fetcher / ExecutionContext / ScheduledController
// are ambient globals from @cloudflare/workers-types (see tsconfig "types").

export interface Env {
  /** D1 binding — replaces ~/.roxabi/corpus.db (aiosqlite). */
  DB: D1Database;
  /** Static-assets binding — serves the v6 frontend (wired in S7, #99). */
  ASSETS: Fetcher;
  /** GitHub PAT for GraphQL sync (S3, #95). */
  GITHUB_TOKEN: string;
  /** GitHub org to sync (e.g. "Roxabi"). */
  GITHUB_ORG: string;
  /** HMAC secret for webhook verification (S5, #97) — differs per env. */
  GITHUB_WEBHOOK_SECRET: string;
  /**
   * Halt-alert webhook (S8, #100) — optional. When the auth-halt breaker trips
   * (2 consecutive auth failures), runSync POSTs a `sync_halted` event here.
   * Set via `wrangler secret put NOTIFY_URL`; unset = alerts disabled.
   */
  NOTIFY_URL?: string;
}
