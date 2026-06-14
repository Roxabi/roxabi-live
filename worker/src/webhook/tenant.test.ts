import { describe, expect, it, vi } from "vitest";
import { getTenantByInstallationId, getTenantByOrgLogin, type TenantRow } from "./tenant";

// ---------------------------------------------------------------------------
// FakeD1 — minimal subset sufficient for single-row .prepare().bind().first()
// ---------------------------------------------------------------------------

type FakeResult = { value?: string; changes?: number; [k: string]: unknown };

interface FakeStmt {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  first: <T = FakeResult>() => Promise<T | null>;
  all: <T = FakeResult>() => Promise<{ results: T[] }>;
}

function makeFakeStmt(
  sql: string,
  args: unknown[],
  rows: FakeResult[],
  changes = 0,
): FakeStmt {
  return {
    sql,
    args,
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
}

function makeFakeDb(
  stmtFactory: (sql: string, args: unknown[]) => FakeStmt,
): D1Database & { _recorded: FakeStmt[] } {
  const recorded: FakeStmt[] = [];

  const db = {
    prepare(sql: string) {
      let directStmt: FakeStmt | null = null;
      const getDirectStmt = (): FakeStmt => {
        if (!directStmt) {
          directStmt = stmtFactory(sql, []);
          recorded.push(directStmt);
        }
        return directStmt;
      };

      return {
        first<T = FakeResult>(): Promise<T | null> {
          return getDirectStmt().first<T>();
        },
        run(): Promise<{ meta: { changes: number } }> {
          return getDirectStmt().run();
        },
        all<T = FakeResult>(): Promise<{ results: T[] }> {
          return getDirectStmt().all<T>();
        },
        bind(...args: unknown[]) {
          const stmt = stmtFactory(sql, args);
          recorded.push(stmt);
          return stmt;
        },
      };
    },
    batch: vi.fn(async (stmts: FakeStmt[]) => {
      await Promise.all(stmts.map((s) => s.run()));
      return stmts.map(() => ({ results: [], meta: { changes: 1 } }));
    }),
    _recorded: recorded,
  } as unknown as D1Database & { _recorded: FakeStmt[] };

  return db;
}

// ---------------------------------------------------------------------------
// Seeded fake-DB — seeds a single tenant row for FROM tenants queries
// ---------------------------------------------------------------------------

function seededDb(tenantRow: TenantRow | null): D1Database & { _recorded: FakeStmt[] } {
  return makeFakeDb((sql, args) => {
    const rows =
      /FROM tenants/.test(sql) && tenantRow ? [tenantRow as unknown as FakeResult] : [];
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
      expect(stmt!.args).toContain(99_000);
      // Column-swap guard: WHERE clause must reference installation_id, not account_login
      expect(stmt!.sql).toMatch(/WHERE\s+installation_id\s*=\s*\?/);
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
      expect(stmt!.args).toContain("Roxabi");
      // Column-swap guard: WHERE clause must reference account_login, not installation_id
      expect(stmt!.sql).toMatch(/WHERE\s+account_login\s*=\s*\?/);
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
