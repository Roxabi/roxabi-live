import { describe, expect, it } from "vitest";
import { type FakeResult, makeFakeDb, makeFakeStmt } from "../test-utils";
import { tryLinkInstallPendingSession } from "./link-install";
import type { SessionContext } from "./types";

const PENDING: SessionContext = {
  userId: 7,
  tenantId: null,
  githubId: 42,
  githubLogin: "alice",
};

describe("tryLinkInstallPendingSession", () => {
  it("links session when exactly one active installation exists", async () => {
    const captured: ReturnType<typeof makeFakeStmt>[] = [];
    const db = makeFakeDb((sql, args) => {
      const rows: FakeResult[] = [];
      if (sql.includes("user_installations") && sql.includes("SELECT")) {
        rows.push({
          tenant_id: 9,
          account_login: "roxabi",
          account_type: "Organization",
        });
      }
      const changes = sql.includes("UPDATE sessions SET tenant_id") ? 1 : 0;
      const stmt = makeFakeStmt(sql, args, rows, changes);
      captured.push(stmt);
      return stmt;
    });

    const tenantId = await tryLinkInstallPendingSession(db, "a".repeat(64), PENDING);

    expect(tenantId).toBe(9);
    expect(captured.some((s) => s.sql.includes("UPDATE sessions SET tenant_id"))).toBe(true);
    expect(captured.some((s) => s.sql.includes("install_targets_json = NULL"))).toBe(true);
  });

  it("returns null when multiple installations exist", async () => {
    const db = makeFakeDb((sql) => {
      if (sql.includes("user_installations") && sql.includes("SELECT")) {
        return makeFakeStmt(
          sql,
          [],
          [
            { tenant_id: 1, account_login: "a", account_type: "User" },
            { tenant_id: 2, account_login: "b", account_type: "Organization" },
          ],
        );
      }
      return makeFakeStmt(sql, [], []);
    });

    const tenantId = await tryLinkInstallPendingSession(db, "a".repeat(64), PENDING);
    expect(tenantId).toBeNull();
  });

  it("returns existing tenant when session already linked", async () => {
    const db = makeFakeDb(() => makeFakeStmt("", [], []));
    const linked: SessionContext = { ...PENDING, tenantId: 3 };
    const tenantId = await tryLinkInstallPendingSession(db, "a".repeat(64), linked);
    expect(tenantId).toBe(3);
  });
});
