/**
 * Cross-route ZK enrollment integration (#216 PR 8).
 * Hono harness + stateful FakeD1: enroll → seal payloads → graph redaction.
 */

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, SessionContext } from "../auth/types";
import { type FakeStmt, makeFakeDb, makeFakeStmt } from "../test-utils";
import type { Env } from "../types";
import { graphRoute } from "./graph";
import { putZkKeyBackupRoute } from "./zk-key-backup";
import { putZkPayloadsRoute } from "./zk-payloads";

afterEach(() => {
  vi.restoreAllMocks();
});

const STUB_SESSION: SessionContext = {
  userId: 7,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

const ISSUE_KEY = "Roxabi/live#42";
const REPO = "Roxabi/live";

const VALID_BACKUP = {
  key_fp: "deadbeef1234567890abcdef12345678",
  kdf_params: JSON.stringify({ m: 65536, t: 3, p: 1 }),
  wrap_iv: "iv-b64",
  wrapped_key: "wrapped-b64",
  backup_version: 1,
};

interface IntegrationState {
  backup: { backup_version: number; key_fp: string } | null;
  payloads: Array<{
    user_id: number;
    issue_key: string;
    pubkey_fp: string;
    key_fp: string;
    encrypted_payload: string;
  }>;
  issues: Map<
    string,
    {
      key: string;
      repo: string;
      number: number;
      title: string;
      state: string;
      url: string | null;
      milestone: string | null;
      lane: string | null;
      priority: string | null;
      size: string | null;
      status: string | null;
      is_stub: number;
      has_active_branch: number;
    }
  >;
  backupPutCount: number;
}

function seedState(): IntegrationState {
  return {
    backup: null,
    payloads: [],
    issues: new Map([
      [
        ISSUE_KEY,
        {
          key: ISSUE_KEY,
          repo: REPO,
          number: 42,
          title: "Secret sprint title",
          state: "open",
          url: `https://github.com/${REPO}/issues/42`,
          milestone: null,
          lane: null,
          priority: null,
          size: null,
          status: null,
          is_stub: 0,
          has_active_branch: 0,
        },
      ],
    ]),
    backupPutCount: 0,
  };
}

function makeIntegrationDb(state: IntegrationState): D1Database {
  return makeFakeDb((sql, args) => {
    const lower = sql.toLowerCase();

    if (lower.includes("sync_control") && lower.includes("select")) {
      return makeFakeStmt(sql, args, []);
    }

    if (lower.includes("insert into sync_control")) {
      const stmt = makeFakeStmt(sql, args, [], 1);
      stmt.run = vi.fn(async () => {
        state.backupPutCount += 1;
        return { meta: { changes: 1 } };
      });
      return stmt;
    }

    if (lower.includes("from zk_key_backups") && lower.includes("select")) {
      if (!state.backup) return makeFakeStmt(sql, args, []);
      return makeFakeStmt(sql, args, [
        {
          backup_version: state.backup.backup_version,
          key_fp: state.backup.key_fp,
          kdf_alg: "argon2id",
          kdf_params: VALID_BACKUP.kdf_params,
          wrap_iv: VALID_BACKUP.wrap_iv,
          wrapped_key: VALID_BACKUP.wrapped_key,
          created_at: "2026-06-18T00:00:00Z",
          updated_at: "2026-06-18T00:00:00Z",
        },
      ]);
    }

    if (lower.includes("insert into zk_key_backups")) {
      const userId = Number(args[0]);
      const keyFp = String(args[5]);
      const stmt = makeFakeStmt(sql, args, [{ user_id: userId }], 1);
      stmt.first = vi.fn(async () => {
        if (state.backup) return null;
        state.backup = { backup_version: 1, key_fp: keyFp };
        return { user_id: userId };
      }) as FakeStmt["first"];
      return stmt;
    }

    if (lower.includes("insert into zk_payloads")) {
      const stmt = makeFakeStmt(sql, args, [], 1);
      stmt.run = vi.fn(async () => {
        const user_id = Number(args[0]);
        const issue_key = String(args[1]);
        const pubkey_fp = String(args[2]);
        const key_fp = String(args[3]);
        const encrypted_payload = String(args[4]);
        const idx = state.payloads.findIndex(
          (p) => p.user_id === user_id && p.issue_key === issue_key,
        );
        const row = {
          user_id,
          issue_key,
          pubkey_fp,
          key_fp,
          encrypted_payload,
        };
        if (idx >= 0) state.payloads[idx] = row;
        else state.payloads.push(row);
        return { meta: { changes: 1 } };
      });
      return stmt;
    }

    if (lower.includes("update issues set payload = json_object()")) {
      const stmt = makeFakeStmt(sql, args, [], 1);
      stmt.run = vi.fn(async () => {
        for (let i = 0; i < args.length; i += 1) {
          const key = String(args[i]);
          const issue = state.issues.get(key);
          if (issue) issue.title = "";
        }
        return { meta: { changes: 1 } };
      });
      return stmt;
    }

    if (lower.includes("distinct issue_key from zk_payloads")) {
      const keys = [...new Set(state.payloads.map((p) => p.issue_key))];
      return makeFakeStmt(
        sql,
        args,
        keys.map((issue_key) => ({ issue_key })),
      );
    }

    if (lower.includes("tenant_repo_access")) {
      return makeFakeStmt(sql, args, [{ repo: REPO, is_private: 0 }]);
    }

    if (lower.includes("from labels")) {
      return makeFakeStmt(sql, args, []);
    }

    if (lower.includes("from pr_state")) {
      return makeFakeStmt(sql, args, []);
    }

    if (lower.includes("from edges")) {
      return makeFakeStmt(sql, args, []);
    }

    if (lower.includes("from repos")) {
      return makeFakeStmt(sql, args, [{ repo: REPO, archived: 0 }]);
    }

    if (lower.includes("from issues")) {
      const issue = state.issues.get(ISSUE_KEY);
      return makeFakeStmt(sql, args, issue ? [{ ...issue }] : []);
    }

    return makeFakeStmt(sql, args, []);
  });
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("ok") } as unknown as Fetcher,
    GITHUB_WEBHOOK_SECRET: "",
    ZK_ACCOUNT_KEY: "1",
  } as unknown as Env;
}

function makeApp(_db: D1Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  app.put("/api/zk/key-backup", putZkKeyBackupRoute);
  app.put("/api/zk/payloads", putZkPayloadsRoute);
  app.get("/api/graph", graphRoute);
  return app;
}

describe("ZK enrollment integration (#216 PR 8)", () => {
  it("enroll → seal payloads → graph returns null titles for sealed issues", async () => {
    const state = seedState();
    const db = makeIntegrationDb(state);
    const app = makeApp(db);
    const env = makeEnv(db);

    const enrollRes = await app.request(
      "/api/zk/key-backup",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BACKUP),
      },
      env,
    );
    expect(enrollRes.status).toBe(200);
    const enrollBody = (await enrollRes.json()) as {
      backup_version: number;
      key_fp: string;
    };
    expect(enrollBody).toEqual({
      backup_version: 1,
      key_fp: VALID_BACKUP.key_fp,
    });
    expect(state.backup).toEqual({
      backup_version: 1,
      key_fp: VALID_BACKUP.key_fp,
    });

    const sealRes = await app.request(
      "/api/zk/payloads",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payloads: [
            {
              issue_key: ISSUE_KEY,
              key_fp: VALID_BACKUP.key_fp,
              encrypted_payload: JSON.stringify({ v: 2, ct: "cipher" }),
            },
          ],
        }),
      },
      env,
    );
    expect(sealRes.status).toBe(200);
    expect(state.payloads).toHaveLength(1);
    expect(state.payloads[0].issue_key).toBe(ISSUE_KEY);

    const graphRes = await app.request("/api/graph", {}, env);
    expect(graphRes.status).toBe(200);
    const graph = (await graphRes.json()) as {
      nodes: Array<{ key: string; title: string | null }>;
    };
    const node = graph.nodes.find((n) => n.key === ISSUE_KEY);
    expect(node).toBeDefined();
    expect(node?.title).toBeNull();
  });
});
