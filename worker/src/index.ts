import { app } from "./router";
import { runSync } from "./sync/sync";
import type { Env } from "./types";

export default {
  fetch: app.fetch,

  // Hourly Cron Trigger (wrangler.toml [triggers].crons = "0 * * * *").
  scheduled: async (
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    await runSync(env);
  },
};
