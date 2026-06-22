import { describe, expect, it } from "vitest";
import { type FakeStmt, makeFakeDb, makeFakeStmt } from "../test-utils";
import { type TenantRow, getTenantByInstallationId, getTenantByOrgLogin } from "./tenant";

// FakeResult kept local: richer variant ({ value?, changes? }) used in seededDb casts
type FakeResult = { value?: string; changes?: number; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Seeded fake-DB — seeds a single tenant row for FROM tenants queries
// ---------------------------------------------------------------------------

function seededDb(tenantRow: TenantRow | null): D1Database & { _recorded: FakeStmt[] } {
  return makeFakeDb((sql, args) => {
    const rows = /FROM tenants/.test(sql) && tenantRow ? [tenantRow as unknown as FakeResult] : [];
    return makeFakeStmt(sql, args, rows, 1);
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TENANT_ROW: TenantRow = {
  id: 1,
  installation_id: 99_000,
  account_login: "Roxabi",
  account_type: "Organization",
  suspended_at: null,
  deleted_at: null,
};

// ---------------------------------------------------------------------------
// getTenantByInstallationId
// ---------------------------------------------------------------------------

describe("getTenantByInstallationId", () => {
  describe("when a matching row exists", () => {
    it("returns the TenantRow with correct fields", async () => {
      // Arrange
      const db = seededDb(TENANT_ROW);

      // Act
      const result = await getTenantByInstallationId(db, 99_000);

      // Assert
      expect(result).toEqual(TENANT_ROW);
    });

    it("binds the installation_id arg to the prepared statement", async () => {
      // Arrange
      const db = seededDb(TENANT_ROW);

      // Act
      await getTenantByInstallationId(db, 99_000);

      // Assert — exactly one statement was bound, carrying the installation_id
      const recorded = db._recorded;
      const stmt = recorded.find((s) => /FROM tenants/.test(s.sql));
      expect(stmt).toBeDefined();
      expect(stmt?.args).toContain(99_000);
      // Column-swap guard: WHERE clause must reference installation_id, not account_login
      expect(stmt?.sql).toMatch(/WHERE\s+installation_id\s*=\s*\?/);
    });
  });

  describe("when no matching row exists", () => {
    it("returns null", async () => {
      // Arrange — unseeded DB, .first() resolves null
      const db = seededDb(null);

      // Act
      const result = await getTenantByInstallationId(db, 42);

      // Assert
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// getTenantByOrgLogin
// ---------------------------------------------------------------------------

describe("getTenantByOrgLogin", () => {
  describe("when a matching row exists", () => {
    it("returns the TenantRow with correct fields", async () => {
      // Arrange
      const db = seededDb(TENANT_ROW);

      // Act
      const result = await getTenantByOrgLogin(db, "Roxabi");

      // Assert
      expect(result).toEqual(TENANT_ROW);
    });

    it("binds the account_login arg to the prepared statement", async () => {
      // Arrange
      const db = seededDb(TENANT_ROW);

      // Act
      await getTenantByOrgLogin(db, "Roxabi");

      // Assert — statement bound with the login string
      const recorded = db._recorded;
      const stmt = recorded.find((s) => /FROM tenants/.test(s.sql));
      expect(stmt).toBeDefined();
      expect(stmt?.args).toContain("Roxabi");
      // Column-swap guard: WHERE clause must reference account_login, not installation_id
      expect(stmt?.sql).toMatch(/WHERE\s+account_login\s*=\s*\?/);
      expect(stmt?.sql).toContain("deleted_at IS NULL");
      expect(stmt?.sql).toContain("ORDER BY created_at DESC");
    });
  });

  describe("when no matching row exists", () => {
    it("returns null", async () => {
      // Arrange
      const db = seededDb(null);

      // Act
      const result = await getTenantByOrgLogin(db, "ghost-org");

      // Assert
      expect(result).toBeNull();
    });
  });
});
