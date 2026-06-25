import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, SessionContext } from "../auth/types";
import { STUB_SESSION, captureDb, dispatchByTable, makeEnv } from "../test-utils";
import { consentRoute } from "./consent";

afterEach(() => {
  vi.restoreAllMocks();
});

const SESSION: SessionContext = {
  ...STUB_SESSION,
  tenantId: 9,
};

function makeApp(session?: SessionContext): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  if (session) {
    app.use("*", async (c, next) => {
      c.set("session", session);
      await next();
    });
  }
  app.post("/api/consent", consentRoute);
  return app;
}

async function postConsent(app: Hono<AuthEnv>, db: D1Database): Promise<Response> {
  return await app.request("/api/consent", { method: "POST" }, makeEnv(db));
}

describe("consentRoute", () => {
  it("returns 401 when session is missing", async () => {
    const { db } = captureDb();
    const res = await postConsent(makeApp(), db);
    expect(res.status).toBe(401);
  });

  it("returns 404 when user row is missing", async () => {
    const { db } = captureDb(() => []);
    const res = await postConsent(makeApp(SESSION), db);
    expect(res.status).toBe(404);
  });

  it("returns consent_at and full me payload on success", async () => {
    const consentAt = "2026-06-19T12:00:00Z";
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        consent_at: [{ consent_at: consentAt }],
        users: [
          {
            zk_opt_in: 0,
            install_targets_json: null,
            consent_at: consentAt,
          },
        ],
        user_installations: [
          { tenant_id: 9, account_login: "Roxabi", account_type: "Organization" },
        ],
      }),
    );
    const res = await postConsent(makeApp(SESSION), db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      consent_at: string;
      onboarding_step: string;
      user: { github_login: string };
    };
    expect(body.consent_at).toBe(consentAt);
    expect(body.onboarding_step).toBe("ready");
    expect(body.user.github_login).toBe(SESSION.githubLogin);
  });

  it("UPDATE uses COALESCE to keep existing consent_at", async () => {
    const { db, stmts } = captureDb((sql) =>
      dispatchByTable(sql, {
        consent_at: [{ consent_at: "2026-01-01T00:00:00Z" }],
        users: [
          {
            zk_opt_in: 0,
            install_targets_json: null,
            consent_at: "2026-01-01T00:00:00Z",
          },
        ],
        user_installations: [
          { tenant_id: 9, account_login: "Roxabi", account_type: "Organization" },
        ],
      }),
    );
    await postConsent(makeApp(SESSION), db);
    const updateStmt = stmts().find((s) => s.sql.includes("consent_at"));
    expect(updateStmt).toBeDefined();
    expect(updateStmt?.sql).toContain("COALESCE(consent_at");
  });
});
