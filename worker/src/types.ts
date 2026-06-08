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
  /**
   * R2 audit bucket (#120) — optional. After each sync run, runSync writes a
   * compact JSON summary (counts, watermark, outcome) to `roxabi-live-logs` as a
   * persistent audit trail. Free-plan alternative to Logpush (which needs Workers
   * Paid). Unset = audit disabled (no-op); never blocks the sync.
   */
  LOGS?: R2Bucket;
  /**
   * Defense-in-depth token for /admin/* endpoints (#123). When set, ALL /admin/*
   * requests must supply `Authorization: Bearer <token>` matching this value.
   * Unset = no Worker-side gate (edge Cloudflare Access / Email-OTP remains the
   * only guard). Set via `wrangler secret put ADMIN_TOKEN` to enable the gate.
   */
  ADMIN_TOKEN?: string;
}
