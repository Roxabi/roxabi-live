/**
 * migrations.test.ts — apply worker/migrations/*.sql against a real in-memory SQLite
 * and assert the resulting schema matches what the app assumes.
 *
 * Uses better-sqlite3 (installed as a devDependency) so this runs inside the
 * existing `npm test` (vitest) job in CI — no CF credentials required.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// worker/src/migrations.test.ts → worker/migrations/ (one level up)
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

type ColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type IndexInfo = { seqno: number; cid: number; name: string };

function getColumns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function getColumnNames(db: Database.Database, table: string): string[] {
  return getColumns(db, table).map((c) => c.name);
}

function getPkColumns(db: Database.Database, table: string): string[] {
  return getColumns(db, table)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

function getIndexColumns(
  db: Database.Database,
  table: string,
  indexName: string,
): string[] {
  const info = db
    .prepare(`PRAGMA index_info(${indexName})`)
    .all() as IndexInfo[];
  return info.sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Apply migrations once for the whole suite
// ---------------------------------------------------------------------------

let db: Database.Database;
let appliedFiles: string[];

beforeAll(() => {
  db = new Database(":memory:");

  appliedFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (appliedFiles.length === 0) {
    throw new Error(`No migration files found in ${MIGRATIONS_DIR}`);
  }

  for (const file of appliedFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
  }
});

// ---------------------------------------------------------------------------
// Suite 1 — migration chain
// ---------------------------------------------------------------------------

describe("migration chain", () => {
  it("applies all migrations without throwing", () => {
    // If beforeAll did not throw, the chain succeeded. Verify the db is usable.
    const result = db
      .prepare("SELECT COUNT(*) AS cnt FROM sync_control")
      .get() as { cnt: number };
    expect(result.cnt).toBeGreaterThan(0);
  });

  it("loads all migration files in lexical order", () => {
    // Uses appliedFiles captured by beforeAll — verifies the actual apply order, not just FS state.
    expect(appliedFiles.length).toBeGreaterThanOrEqual(9);
    expect(appliedFiles[0]).toMatch(/^0001_/);
    // Contiguity check: each file's 4-digit prefix must equal its 1-based position
    for (let i = 0; i < appliedFiles.length; i++) {
      expect(parseInt(appliedFiles[i].slice(0, 4), 10)).toBe(i + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — issues table schema
// ---------------------------------------------------------------------------

describe("issues table", () => {
  it("has a payload column", () => {
    expect(getColumnNames(db, "issues")).toContain("payload");
  });

  it("does NOT have a title column (moved into payload JSON in 0004)", () => {
    expect(getColumnNames(db, "issues")).not.toContain("title");
  });

  it("does NOT have a tenant_id column (repo-canonical pivot — no tenant_id on data tables)", () => {
    expect(getColumnNames(db, "issues")).not.toContain("tenant_id");
  });

  it("has key as the primary key", () => {
    expect(getPkColumns(db, "issues")).toEqual(["key"]);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — repos table schema
// ---------------------------------------------------------------------------

describe("repos table", () => {
  it("does NOT have a tenant_id column (repo-canonical pivot)", () => {
    expect(getColumnNames(db, "repos")).not.toContain("tenant_id");
  });

  it("has repo as the primary key", () => {
    expect(getPkColumns(db, "repos")).toEqual(["repo"]);
  });

  it("has a repo_node_id column (added in 0004)", () => {
    expect(getColumnNames(db, "repos")).toContain("repo_node_id");
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — sync_control composite PK
// ---------------------------------------------------------------------------

describe("sync_control table", () => {
  it("has composite primary key (tenant_id, key)", () => {
    // PRAGMA table_info pk column: non-zero = part of PK; pk value = position (1-based)
    expect(getPkColumns(db, "sync_control")).toEqual(["tenant_id", "key"]);
  });

  it("has value column that is NOT NULL (restored in 0008)", () => {
    const col = getColumns(db, "sync_control").find((c) => c.name === "value");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
  });

  it("contains the global sentinel rows with tenant_id=0", () => {
    const rows = db
      .prepare("SELECT key FROM sync_control WHERE tenant_id = 0 ORDER BY key")
      .all() as { key: string }[];
    const keys = rows.map((r) => r.key);
    // Seeds from 0001, 0003, 0005, 0006 (all migrated into new table by 0004 + 0008)
    expect(keys).toContain("auth_failures");
    expect(keys).toContain("halted");
    expect(keys).toContain("sync_running");
    expect(keys).toContain("sync_slot");
    expect(keys).toContain("data_version");
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — zk_payloads composite PK
// ---------------------------------------------------------------------------

describe("zk_payloads table", () => {
  it("has composite primary key (user_id, issue_key)", () => {
    expect(getPkColumns(db, "zk_payloads")).toEqual(["user_id", "issue_key"]);
  });

  it("has expected columns", () => {
    const cols = getColumnNames(db, "zk_payloads");
    expect(cols).toContain("user_id");
    expect(cols).toContain("issue_key");
    expect(cols).toContain("pubkey_fp");
    expect(cols).toContain("encrypted_payload");
    expect(cols).toContain("updated_at");
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — tenant_repo_access schema
// ---------------------------------------------------------------------------

describe("tenant_repo_access table", () => {
  it("has composite primary key (tenant_id, repo)", () => {
    expect(getPkColumns(db, "tenant_repo_access")).toEqual([
      "tenant_id",
      "repo",
    ]);
  });

  it("has is_private column (added in 0007) defaulting to 1", () => {
    const col = getColumns(db, "tenant_repo_access").find(
      (c) => c.name === "is_private",
    );
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — tenants table
// ---------------------------------------------------------------------------

describe("users table", () => {
  it("has zk_opt_in column (Phase 2 opt-in, added in 0010)", () => {
    expect(getColumnNames(db, "users")).toContain("zk_opt_in");
  });

  it("zk_opt_in defaults to 0 (server-readable mode)", () => {
    const col = getColumns(db, "users").find((c) => c.name === "zk_opt_in");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe("0");
  });
});

describe("tenants table", () => {
  it("has deleted_at column (soft-delete, added in 0009)", () => {
    expect(getColumnNames(db, "tenants")).toContain("deleted_at");
  });

  it("deleted_at is nullable (NULL = active)", () => {
    const col = getColumns(db, "tenants").find((c) => c.name === "deleted_at");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — edges and indexes
// ---------------------------------------------------------------------------

describe("edges table and indexes", () => {
  it("has composite primary key (src_key, dst_key, kind)", () => {
    expect(getPkColumns(db, "edges")).toEqual(["src_key", "dst_key", "kind"]);
  });

  it("ix_edges_dst index exists on edges(dst_key)", () => {
    const cols = getIndexColumns(db, "edges", "ix_edges_dst");
    expect(cols).toEqual(["dst_key"]);
  });
});
