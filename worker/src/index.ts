import { app } from "./router";
import type { Env } from "./types";

export default {
  fetch: app.fetch,

  // Hourly Cron Trigger (wrangler.toml [triggers].crons = "0 * * * *").
  // The GitHub-sync engine lands in S4 (#96); until then this is an intentional
  // no-op so scheduled invocations succeed instead of erroring on a missing handler.
  scheduled: async (
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    console.log("[cron] scheduled sync not yet implemented — see #96 (S4)");
  },
};
