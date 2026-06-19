import { describe, expect, it, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { listZkPayloadsRoute, putZkPayloadsRoute } from "./zk-payloads";
import type { AuthEnv, SessionContext } from "../auth/types";
import { captureDb } from "../test-utils";

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

function makeApp(db: D1Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("session", STUB_SESSION);
    await next();
  });
  app.get("/api/zk/payloads", listZkPayloadsRoute);
  app.put("/api/zk/payloads", putZkPayloadsRoute);
  return app;
}

describe("listZkPayloadsRoute", () => {
  it("returns 403 when zk_opt_in is off", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 0 }];
      return [];
    });
    const res = await makeApp(db).request("/api/zk/payloads", {}, makeEnv(db));
    expect(res.status).toBe(403);
  });

  it("returns payloads when zk_opt_in is on", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_opt_in")) return [{ zk_opt_in: 1 }];
      if (sql.includes("zk_payloads")) {
        return [{
          issue_key: "Roxabi/live#1",
          pubkey_fp: "abc123",
          encrypted_payload: "cipher",
          updated_at: "2026-01-01",
        }];
      }
      return [];
    });
    const res = await makeApp(db).request("/api/zk/payloads", {}, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as { payloads: unknown[] };
    expect(body.payloads).toHaveLength(1);
  });
});

describe("putZkPayloadsRoute", () => {
  it("upserts ciphertext rows without requiring zk_opt_in", async () => {
    const { db, stmts } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/payloads",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payloads: [{
            issue_key: "Roxabi/live#42",
            pubkey_fp: "deadbeef1234567890abcdef12345678",
            encrypted_payload: "envelope-json",
          }],
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const upsert = stmts().find((s) => s.sql.includes("INSERT INTO zk_payloads"));
    expect(upsert).toBeDefined();
    expect(upsert!.args[0]).toBe(7);
    expect(upsert!.args[1]).toBe("Roxabi/live#42");
    expect(upsert!.sql).toContain("key_fp");
  });

  it("accepts key_fp alias and dual-writes pubkey_fp", async () => {
    const { db, stmts } = captureDb(() => []);
    const res = await makeApp(db).request(
      "/api/zk/payloads",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payloads: [{
            issue_key: "Roxabi/live#7",
            key_fp: "cafebabe1234567890abcdef12345678",
            encrypted_payload: "v2-envelope",
          }],
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const upsert = stmts().find((s) => s.sql.includes("INSERT INTO zk_payloads"));
    expect(upsert!.args[2]).toBe("cafebabe1234567890abcdef12345678");
    expect(upsert!.args[3]).toBe("cafebabe1234567890abcdef12345678");
  });

  it("scrubs plaintext titles from issues.payload after upsert", async () => {
    const { db, stmts } = captureDb(() => []);
    await makeApp(db).request(
      "/api/zk/payloads",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payloads: [{
            issue_key: "Roxabi/live#99",
            pubkey_fp: "deadbeef1234567890abcdef12345678",
            encrypted_payload: "envelope-json",
          }],
        }),
      },
      makeEnv(db),
    );
    const scrub = stmts().find(
      (s) => s.sql.includes("UPDATE issues SET payload = json_object()"),
    );
    expect(scrub).toBeDefined();
    expect(scrub!.args).toContain("Roxabi/live#99");
  });
});