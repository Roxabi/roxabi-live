import { describe, expect, it, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { postZkResetRoute, purgeUserZkData } from "./zk-reset";
import type { AuthEnv, SessionContext } from "../auth/types";
import { makeFakeDb, makeFakeStmt } from "../test-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

const VALID_PROOF = "0123456789abcdef0123456789abcdef";

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("ok") } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
    ZK_ACCOUNT_KEY: "1",
    ...overrides,
  } as unknown as Env;
}

function makeApp(db: D1Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  app.post("/api/zk/reset", postZkResetRoute);
  return app;
}

describe("postZkResetRoute", () => {
  it("returns 403 when ZK_ACCOUNT_KEY flag is off", async () => {
    const db = makeFakeDb(() => makeFakeStmt("", [], []));
    const res = await makeApp(db).request(
      "/api/zk/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reauth_proof: VALID_PROOF }),
      },
      makeEnv(db, { ZK_ACCOUNT_KEY: "0" }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 without reauth_proof", async () => {
    const db = makeFakeDb(() => makeFakeStmt("", [], []));
    const res = await makeApp(db).request(
      "/api/zk/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("reauth_required");
  });

  it("returns 403 when reauth proof is invalid", async () => {
    const db = makeFakeDb((sql) => {
      if (sql.includes("zk_reauth_proofs") && sql.includes("SELECT")) {
        return makeFakeStmt(sql, [], []);
      }
      return makeFakeStmt(sql, [], []);
    });
    const res = await makeApp(db).request(
      "/api/zk/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reauth_proof: VALID_PROOF }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(403);
  });

  it("purges user ZK data on valid reauth", async () => {
    const captured: ReturnType<typeof makeFakeStmt>[] = [];
    const db = makeFakeDb((sql, args) => {
      let rows: Record<string, unknown>[] = [];
      let changes = 0;
      if (sql.includes("SELECT DISTINCT issue_key FROM zk_payloads WHERE user_id")) {
        rows = [{ issue_key: "Roxabi/live#1" }];
      } else if (sql.includes("SELECT COUNT(*)")) {
        rows = [{ n: 2 }];
      } else if (sql.includes("SELECT DISTINCT issue_key FROM zk_payloads")) {
        rows = [];
      } else if (sql.includes("zk_reauth_proofs") && sql.includes("SELECT")) {
        rows = [{ ok: 1 }];
      } else if (sql.includes("zk_reauth_proofs") && sql.includes("DELETE")) {
        rows = [{ code: VALID_PROOF }];
        changes = 1;
      } else if (sql.includes("sync_control") && sql.includes("zk_reset")) {
        changes = 1;
      } else if (sql.startsWith("DELETE") || sql.includes("UPDATE issues")) {
        changes = 1;
      }
      const stmt = makeFakeStmt(sql, args, rows, changes);
      captured.push(stmt);
      return stmt;
    });

    const res = await makeApp(db).request(
      "/api/zk/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reauth_proof: VALID_PROOF }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; payloads_deleted: number };
    expect(body.ok).toBe(true);
    expect(body.payloads_deleted).toBe(2);

    expect(
      captured.some((s) => s.sql.includes("DELETE FROM zk_payloads")),
    ).toBe(true);
    expect(
      captured.some((s) => s.sql.includes("DELETE FROM zk_key_backups")),
    ).toBe(true);

    const consumeIdx = captured.findIndex(
      (s) =>
        s.sql.includes("zk_reauth_proofs") &&
        s.sql.includes("DELETE") &&
        s.sql.includes("RETURNING"),
    );
    const purgeIdx = captured.findIndex((s) =>
      s.sql.includes("DELETE FROM zk_payloads"),
    );
    expect(consumeIdx).toBeGreaterThanOrEqual(0);
    expect(purgeIdx).toBeGreaterThan(consumeIdx);
  });
});

describe("purgeUserZkData", () => {
  it("scrubs issues only when no other user still seals them", async () => {
    const captured: ReturnType<typeof makeFakeStmt>[] = [];
    const db = makeFakeDb((sql, args) => {
      let rows: Record<string, unknown>[] = [];
      let changes = 0;
      if (sql.includes("SELECT DISTINCT issue_key FROM zk_payloads WHERE user_id")) {
        rows = [{ issue_key: "Roxabi/live#9" }];
      } else if (sql.includes("SELECT COUNT(*)")) {
        rows = [{ n: 1 }];
      } else if (sql.includes("SELECT DISTINCT issue_key FROM zk_payloads")) {
        rows = [];
      } else if (sql.startsWith("DELETE") || sql.includes("UPDATE issues")) {
        changes = 1;
      }
      const stmt = makeFakeStmt(sql, args, rows, changes);
      captured.push(stmt);
      return stmt;
    });

    const stats = await purgeUserZkData(db, 7);
    expect(stats.payloads_deleted).toBe(1);
    expect(stats.issues_scrubbed).toBe(1);
    expect(
      captured.some((s) => s.sql.includes("UPDATE issues SET payload")),
    ).toBe(true);
  });
});