import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb, dispatchByTable, makeEnv } from "../test-utils";
import { postAccountDeleteRoute, purgeUserAccountData } from "./account-delete";

afterEach(() => {
  vi.restoreAllMocks();
});

const SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

const PROOF = "0123456789abcdef0123456789abcdef";

function makeApp(session: SessionContext | undefined): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  if (session) {
    app.use("*", async (c, next) => {
      c.set("session", session);
      await next();
    });
  }
  app.post("/api/account/delete", postAccountDeleteRoute);
  return app;
}

describe("purgeUserAccountData", () => {
  it("deletes zk rows, installs, sessions, and clears consent", async () => {
    const { db, stmts } = captureDb((sql) =>
      dispatchByTable(sql, {
        zk_payloads: [{ issue_key: "a/b#1" }],
        zk_key_backups: [{ ok: 1 }],
      }),
    );

    await purgeUserAccountData(db, 7);

    const sqls = stmts().map((s) => s.sql);
    expect(sqls.some((s) => s.includes("DELETE FROM zk_payloads"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM zk_key_backups"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM user_installations"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM user_repo_permission_cache"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM sessions"))).toBe(true);
    expect(sqls.some((s) => s.includes("consent_at = NULL"))).toBe(true);
  });
});

describe("postAccountDeleteRoute", () => {
  it("returns 401 without session", async () => {
    const { db } = captureDb();
    const res = await makeApp(undefined).request(
      "/api/account/delete",
      { method: "POST" },
      { ...makeEnv(db), ZK_ACCOUNT_KEY: "1" },
    );
    expect(res.status).toBe(401);
  });

  it("purges and clears cookies when no zk backup", async () => {
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        zk_key_backups: [],
        zk_payloads: [],
      }),
    );
    const env = { ...makeEnv(db), ZK_ACCOUNT_KEY: "1" };

    const res = await makeApp(SESSION).request(
      "/api/account/delete",
      { method: "POST", headers: { Cookie: `roxabi_session=${"a".repeat(64)}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(res.headers.get("Clear-Site-Data")).toContain("cookies");
  });

  it("returns 403 reauth_required when zk backup exists without proof", async () => {
    const { db } = captureDb((sql) =>
      dispatchByTable(sql, {
        zk_key_backups: [{ ok: 1 }],
      }),
    );
    const env = { ...makeEnv(db), ZK_ACCOUNT_KEY: "1" };

    const res = await makeApp(SESSION).request(
      "/api/account/delete",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("reauth_required");
  });

  it("deletes account when zk backup exists and reauth proof is valid", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_reauth_proofs") && sql.includes("SELECT")) {
        return [{ ok: 1 }];
      }
      if (sql.includes("zk_reauth_proofs") && sql.includes("DELETE")) {
        return [{ code: PROOF }];
      }
      return dispatchByTable(sql, {
        zk_key_backups: [{ ok: 1 }],
        zk_payloads: [],
      });
    });
    const env = { ...makeEnv(db), ZK_ACCOUNT_KEY: "1" };

    const res = await makeApp(SESSION).request(
      "/api/account/delete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `roxabi_session=${"a".repeat(64)}` },
        body: JSON.stringify({ reauth_proof: PROOF }),
      },
      env,
    );

    expect(res.status).toBe(200);
  });
});
