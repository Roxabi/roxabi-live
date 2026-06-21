import { assertZkConfigCoherent } from "./auth/zk-flags";
import { app } from "./router";
import { runSync } from "./sync/sync";
import type { Env } from "./types";

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> => {
    assertZkConfigCoherent(env);
    return app.fetch(req, env, ctx);
  },

  // Cron trigger disabled in wrangler.toml — manual via POST /admin/sync for drift
  // checks. Handler kept so re-enabling crons does not require code changes.
  scheduled: async (
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    assertZkConfigCoherent(env);
    await runSync(env);
  },
};
