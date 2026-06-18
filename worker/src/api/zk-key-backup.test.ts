import { describe, expect, it, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import {
  getZkKeyBackupRoute,
  putZkKeyBackupRoute,
} from "./zk-key-backup";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb, makeFakeDb, makeFakeStmt } from "../test-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

const VALID_BODY = {
  key_fp: "deadbeef12345678",
  kdf_params: JSON.stringify({ m: 65536, t: 3, p: 1 }),
  wrap_iv: "iv-b64",
  wrapped_key: "wrapped-b64",
  backup_version: 1,
};

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
  app.get("/api/zk/key-backup", getZkKeyBackupRoute);
  app.put("/api/zk/key-backup", putZkKeyBackupRoute);
  return app;
}

describe("getZkKeyBackupRoute", () => {
  it("returns 403 when ZK_ACCOUNT_KEY flag is off", async () => {
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {},
      makeEnv(db, { ZK_ACCOUNT_KEY: "0" }),
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("zk_account_key_disabled");
  });

  it("returns 404 when not enrolled", async () => {
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request("/api/zk/key-backup", {}, makeEnv(db));
    expect(res.status).toBe(404);
  });

  it("returns backup row when enrolled", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_key_backups")) {
        return [{
          backup_version: 1,
          kdf_alg: "argon2id",
          kdf_params: "{}",
          wrap_iv: "iv",
          wrapped_key: "wk",
          key_fp: "abcd1234",
          created_at: "t1",
          updated_at: "t2",
        }];
      }
      return [];
    });
    const res = await makeApp(db).request("/api/zk/key-backup", {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as { key_fp: string };
    expect(body.key_fp).toBe("abcd1234");
  });
});

describe("putZkKeyBackupRoute", () => {
  it("returns 403 when ZK_ACCOUNT_KEY flag is off", async () => {
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      },
      makeEnv(db, { ZK_ACCOUNT_KEY: "0" }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects weak kdf_params", async () => {
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          kdf_params: JSON.stringify({ m: 8192, t: 3, p: 1 }),
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid kdf_params");
  });

  it("rejects excessive kdf_params", async () => {
    const { db } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          kdf_params: JSON.stringify({ m: 131072, t: 3, p: 1 }),
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
  });

  it("does not increment rate limit on validation failure", async () => {
    const { db, stmts } = captureDb((sql) => {
      if (sql.includes("zk_key_backups") && sql.includes("SELECT")) {
        return [{ backup_version: 1, key_fp: VALID_BODY.key_fp }];
      }
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          kdf_params: JSON.stringify({ m: 1024, t: 1, p: 1 }),
          expected_backup_version: 1,
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    const rateStmt = stmts().find(
      (s) => s.sql.includes("sync_control") && s.sql.includes("INSERT"),
    );
    expect(rateStmt).toBeUndefined();
  });

  it("inserts on first enroll", async () => {
    const { db, stmts } = captureDb((sql) => {
      if (sql.includes("zk_key_backups") && sql.includes("SELECT")) return [];
      if (sql.includes("INSERT INTO zk_key_backups")) return [{ user_id: 7 }];
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const insert = stmts().find((s) => s.sql.includes("INSERT INTO zk_key_backups"));
    expect(insert).toBeDefined();
  });

  it("returns 409 enrolled when different key_fp without rotation", async () => {
    const { db, stmts } = captureDb((sql) => {
      if (sql.includes("zk_key_backups") && sql.includes("SELECT")) {
        return [{ backup_version: 1, key_fp: "original1234" }];
      }
      if (sql.includes("zk_reauth_proofs") && sql.includes("DELETE")) {
        return [{ code: "0123456789abcdef0123456789abcdef" }];
      }
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          expected_backup_version: 1,
          reauth_proof: "0123456789abcdef0123456789abcdef",
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("enrolled");
    const deleteProof = stmts().find(
      (s) => s.sql.includes("zk_reauth_proofs") && s.sql.includes("DELETE"),
    );
    expect(deleteProof).toBeUndefined();
  });

  it("updates backup when reauth_proof is valid", async () => {
    const proof = "0123456789abcdef0123456789abcdef";
    const captured: ReturnType<typeof makeFakeStmt>[] = [];
    const db = makeFakeDb((sql, args) => {
      let rows: Record<string, unknown>[] = [];
      let changes = 0;
      if (sql.includes("zk_key_backups") && sql.includes("SELECT")) {
        rows = [{ backup_version: 1, key_fp: VALID_BODY.key_fp }];
      } else if (sql.includes("zk_reauth_proofs") && sql.includes("DELETE")) {
        rows = [{ code: proof }];
        changes = 1;
      } else if (sql.includes("UPDATE zk_key_backups")) {
        changes = 1;
      } else if (sql.includes("sync_control")) {
        changes = 1;
      } else if (sql.includes("INSERT INTO zk_key_backups")) {
        rows = [{ user_id: 7 }];
        changes = 1;
      }
      const stmt = makeFakeStmt(sql, args, rows, changes);
      captured.push(stmt);
      return stmt;
    });
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          expected_backup_version: 1,
          reauth_proof: proof,
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { backup_version: number };
    expect(body.backup_version).toBe(2);
    const update = captured.find((s) => s.sql.includes("UPDATE zk_key_backups"));
    expect(update?.sql).toContain("backup_version = ?");
    expect(update?.args).toContain(1);
  });

  it("returns 403 reauth_required on update without proof", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_key_backups") && sql.includes("SELECT")) {
        return [{ backup_version: 1, key_fp: VALID_BODY.key_fp }];
      }
      return [];
    });
    const res = await makeApp(db).request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          expected_backup_version: 1,
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("reauth_required");
  });
});