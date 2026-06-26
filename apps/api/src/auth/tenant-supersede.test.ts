import { describe, expect, it, vi } from "vitest";
import { type FakeStmt, makeFakeDb, makeFakeStmt } from "../test-utils";
import { listStaleTenantIds, pickSessionTenantId, supersedeStaleTenants } from "./tenant-supersede";

type FakeResult = { id?: number; [k: string]: unknown };

function dbWithTenants(rows: FakeResult[]): D1Database & { _recorded: FakeStmt[] } {
  return makeFakeDb((sql, args) => {
    if (/SELECT id FROM tenants/.test(sql) && /installation_id !=/.test(sql)) {
      return makeFakeStmt(sql, args, rows);
    }
    if (/SELECT t\.id AS id/.test(sql) && /tenant_repo_access/.test(sql)) {
      return makeFakeStmt(sql, args, rows.length ? [rows[0]] : []);
    }
    return makeFakeStmt(sql, args, []);
  });
}

describe("listStaleTenantIds", () => {
  it("returns active tenants with a different installation_id", async () => {
    const db = dbWithTenants([{ id: 1 }, { id: 2 }]);
    const ids = await listStaleTenantIds(db, "Roxabi", "Organization", 141589075);
    expect(ids).toEqual([1, 2]);
  });

  it("returns an empty array when none match", async () => {
    const db = dbWithTenants([]);
    const ids = await listStaleTenantIds(db, "Roxabi", "Organization", 141589075);
    expect(ids).toEqual([]);
  });
});

describe("supersedeStaleTenants", () => {
  it("batches soft-delete + cleanup + session migration for each stale tenant", async () => {
    const db = makeFakeDb((sql, args) => {
      if (/SELECT id FROM tenants/.test(sql)) {
        return makeFakeStmt(sql, args, [{ id: 1 }]);
      }
      return makeFakeStmt(sql, args, []);
    });
    const batch = vi.fn(async () => []);
    (db as unknown as { batch: unknown }).batch = batch;

    const stale = await supersedeStaleTenants(db, {
      keepTenantId: 3,
      accountLogin: "Roxabi",
      accountType: "Organization",
      installationId: 141589075,
      nowIso: "2026-06-21T00:00:00.000Z",
    });

    expect(stale).toEqual([1]);
    expect(batch).toHaveBeenCalledTimes(1);
    const stmts = (batch.mock.calls[0] as unknown as [FakeStmt[]])[0];
    expect(stmts).toHaveLength(5);
    expect(stmts.some((s) => /UPDATE tenants SET deleted_at/.test(s.sql))).toBe(true);
    expect(stmts.some((s) => /DELETE FROM tenant_repo_access/.test(s.sql))).toBe(true);
    expect(stmts.some((s) => /DELETE FROM install_tokens/.test(s.sql))).toBe(true);
    expect(stmts.some((s) => /DELETE FROM user_installations/.test(s.sql))).toBe(true);
    expect(stmts.some((s) => /UPDATE sessions SET tenant_id/.test(s.sql))).toBe(true);
  });

  it("no-ops when there are no stale tenants", async () => {
    const db = makeFakeDb(() => makeFakeStmt("", [], []));
    const batch = vi.fn(async () => []);
    (db as unknown as { batch: unknown }).batch = batch;

    const stale = await supersedeStaleTenants(db, {
      keepTenantId: 3,
      accountLogin: "Roxabi",
      accountType: "Organization",
      installationId: 141589075,
      nowIso: "2026-06-21T00:00:00.000Z",
    });

    expect(stale).toEqual([]);
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("pickSessionTenantId", () => {
  it("returns the sole tenant id without querying", async () => {
    const db = makeFakeDb(() => makeFakeStmt("", [], []));
    await expect(pickSessionTenantId(db, [7])).resolves.toBe(7);
  });

  it("prefers the tenant with the most repo access rows", async () => {
    const db = dbWithTenants([{ id: 3 }]);
    await expect(pickSessionTenantId(db, [1, 2, 3])).resolves.toBe(3);
  });

  it("returns null for an empty candidate list", async () => {
    const db = makeFakeDb(() => makeFakeStmt("", [], []));
    await expect(pickSessionTenantId(db, [])).resolves.toBeNull();
  });
});
