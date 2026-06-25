import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb } from "../test-utils";
import type { Env } from "../types";
import { consumeZkHandoffRoute } from "./zk-handoff";

vi.mock("../auth/userTokenHandoff", () => ({
  consumeUserTokenHandoff: vi.fn(),
}));

import { consumeUserTokenHandoff } from "../auth/userTokenHandoff";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
  } as unknown as Env;
}

function makeApp(_db: D1Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  app.post("/api/zk/consume-handoff", consumeZkHandoffRoute);
  return app;
}

describe("consumeZkHandoffRoute", () => {
  it("returns github_token on successful consume", async () => {
    vi.mocked(consumeUserTokenHandoff).mockResolvedValue("gho_secret");
    const { db } = captureDb(() => []);
    const code = "a".repeat(32);
    const res = await makeApp(db).request(
      "/api/zk/consume-handoff",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { github_token: string };
    expect(body.github_token).toBe("gho_secret");
    expect(consumeUserTokenHandoff).toHaveBeenCalledWith(expect.anything(), 7, code);
  });

  it("returns 410 when handoff expired", async () => {
    vi.mocked(consumeUserTokenHandoff).mockResolvedValue(null);
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/consume-handoff",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "b".repeat(32) }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(410);
  });
});
