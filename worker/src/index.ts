import { app } from "./router";
import { runSync } from "./sync/sync";
import type { Env } from "./types";

export default {
  fetch: app.fetch,

  // Daily Cron Trigger (wrangler.toml [triggers].crons = "0 0 * * *") — runs a
  // FULL reconcile (since=null) so deps-only edge changes are healed daily (#80).
  scheduled: async (
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    await runSync(env);
  },
};
