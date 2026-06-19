import { app } from "./router";
import { runSync } from "./sync/sync";
import { assertZkConfigCoherent } from "./auth/zk-flags";
import type { Env } from "./types";

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> => {
    assertZkConfigCoherent(env);
    return app.fetch(req, env, ctx);
  },

  // Daily Cron Trigger (wrangler.toml [triggers].crons = "0 0 * * *") — runs a
  // FULL reconcile (since=null) so deps-only edge changes are healed daily (#80).
  scheduled: async (
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    assertZkConfigCoherent(env);
    await runSync(env);
  },
};
