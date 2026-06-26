/**
 * migrations.test.ts — apply worker/migrations/*.sql against a real in-memory SQLite
 * and assert the resulting schema matches what the app assumes.
 *
 * Uses better-sqlite3 (installed as a devDependency) so this runs inside the
 * existing `npm test` (vitest) job in CI — no CF credentials required.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

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

function getIndexColumns(db: Database.Database, _table: string, indexName: string): string[] {
  const info = db.prepare(`PRAGMA index_info(${indexName})`).all() as IndexInfo[];
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
    const result = db.prepare("SELECT COUNT(*) AS cnt FROM sync_control").get() as { cnt: number };
    expect(result.cnt).toBeGreaterThan(0);
  });

  it("loads all migration files in lexical order", () => {
    // Uses appliedFiles captured by beforeAll — verifies the actual apply order, not just FS state.
    expect(appliedFiles.length).toBeGreaterThanOrEqual(15);
    expect(appliedFiles[0]).toMatch(/^0001_/);
    // Contiguity check: each file's 4-digit prefix must equal its 1-based position
    for (let i = 0; i < appliedFiles.length; i++) {
      expect(Number.parseInt(appliedFiles[i].slice(0, 4), 10)).toBe(i + 1);
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
    expect(cols).toContain("key_fp");
    expect(cols).toContain("encrypted_payload");
    expect(cols).toContain("updated_at");
  });

  it("key_fp is nullable (0014)", () => {
    const col = getColumns(db, "zk_payloads").find((c) => c.name === "key_fp");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });
});

describe("zk_key_backups table", () => {
  it("has user_id primary key (0014)", () => {
    expect(getPkColumns(db, "zk_key_backups")).toEqual(["user_id"]);
  });

  it("has expected columns", () => {
    const cols = getColumnNames(db, "zk_key_backups");
    expect(cols).toContain("user_id");
    expect(cols).toContain("backup_version");
    expect(cols).toContain("kdf_alg");
    expect(cols).toContain("kdf_params");
    expect(cols).toContain("wrap_iv");
    expect(cols).toContain("wrapped_key");
    expect(cols).toContain("key_fp");
    expect(cols).toContain("created_at");
    expect(cols).toContain("updated_at");
  });

  it("backup_version defaults to 1", () => {
    const col = getColumns(db, "zk_key_backups").find((c) => c.name === "backup_version");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe("1");
  });
});

describe("0014_zk_key_backups", () => {
  it("backfills key_fp from pubkey_fp on existing rows", () => {
    const migDb = new Database(":memory:");
    const pre = appliedFiles.filter(
      (f) => !f.startsWith("0014_") && !f.startsWith("0015_") && !f.startsWith("0016_"),
    );
    for (const file of pre) {
      migDb.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    migDb.exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES (1, 1, 'tester');
      INSERT INTO zk_payloads (user_id, issue_key, pubkey_fp, encrypted_payload, updated_at)
      VALUES (1, 'Roxabi/live#1', 'abc12345', 'cipher', datetime('now'));
    `);
    migDb.exec(readFileSync(join(MIGRATIONS_DIR, "0014_zk_key_backups.sql"), "utf8"));
    const row = migDb
      .prepare("SELECT pubkey_fp, key_fp FROM zk_payloads WHERE issue_key = ?")
      .get("Roxabi/live#1") as { pubkey_fp: string; key_fp: string | null };
    expect(row.pubkey_fp).toBe("abc12345");
    expect(row.key_fp).toBe("abc12345");
    migDb.close();
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — tenant_repo_access schema
// ---------------------------------------------------------------------------

describe("tenant_repo_access table", () => {
  it("has composite primary key (tenant_id, repo)", () => {
    expect(getPkColumns(db, "tenant_repo_access")).toEqual(["tenant_id", "repo"]);
  });

  it("has is_private column (added in 0007) defaulting to 1", () => {
    const col = getColumns(db, "tenant_repo_access").find((c) => c.name === "is_private");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — tenants table
// ---------------------------------------------------------------------------

describe("users.consent_at column", () => {
  it("exists after 0020 migration", () => {
    const cols = getColumnNames(db, "users");
    expect(cols).toContain("consent_at");
  });
});

describe("oauth_exchange table", () => {
  it("has code primary key (0019)", () => {
    expect(getPkColumns(db, "oauth_exchange")).toEqual(["code"]);
  });

  it("has expected columns", () => {
    const cols = getColumnNames(db, "oauth_exchange");
    expect(cols).toContain("session_token");
    expect(cols).toContain("redirect_after");
    expect(cols).toContain("expires_at");
  });
});

describe("user_token_handoffs table", () => {
  it("has code primary key (0011)", () => {
    expect(getPkColumns(db, "user_token_handoffs")).toEqual(["code"]);
  });

  it("has expected columns", () => {
    const cols = getColumnNames(db, "user_token_handoffs");
    expect(cols).toContain("user_id");
    expect(cols).toContain("token_enc");
    expect(cols).toContain("token_iv");
    expect(cols).toContain("expires_at");
  });
});

describe("oauth_state zk_token_handoff", () => {
  it("has zk_token_handoff column (0011)", () => {
    expect(getColumnNames(db, "oauth_state")).toContain("zk_token_handoff");
  });

  it("has reauth column (0015)", () => {
    expect(getColumnNames(db, "oauth_state")).toContain("reauth");
  });

  it("has remember column (0021)", () => {
    expect(getColumnNames(db, "oauth_state")).toContain("remember");
  });
});

describe("zk_reauth_proofs table", () => {
  it("has code primary key (0015)", () => {
    expect(getPkColumns(db, "zk_reauth_proofs")).toEqual(["code"]);
  });
});

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

describe("0013_zk_always_on", () => {
  it("sets zk_opt_in = 1 for all users", () => {
    const migDb = new Database(":memory:");
    const pre = appliedFiles.filter((f) => !f.startsWith("0013_"));
    for (const file of pre) {
      migDb.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    migDb.exec(`
      INSERT INTO users (id, github_id, github_login, zk_opt_in)
      VALUES (1, 1, 'off', 0), (2, 2, 'on', 1);
    `);
    migDb.exec(readFileSync(join(MIGRATIONS_DIR, "0013_zk_always_on.sql"), "utf8"));
    const rows = migDb
      .prepare("SELECT github_login, zk_opt_in FROM users ORDER BY id")
      .all() as Array<{ github_login: string; zk_opt_in: number }>;
    expect(rows).toEqual([
      { github_login: "off", zk_opt_in: 1 },
      { github_login: "on", zk_opt_in: 1 },
    ]);
    migDb.close();
  });
});

describe("0012_scrub_zk_sealed_payloads", () => {
  it("clears issues.payload for keys present in zk_payloads", () => {
    const scrubDb = new Database(":memory:");
    const preScrub = appliedFiles.filter((f) => !f.startsWith("0012_"));
    for (const file of preScrub) {
      scrubDb.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    scrubDb.exec(`
      INSERT INTO users (id, github_id, github_login)
      VALUES (1, 1, 'tester');
      INSERT INTO issues (key, repo, number, payload, state)
      VALUES ('Roxabi/live#1', 'Roxabi/live', 1, json_object('title', 'secret'), 'open'),
             ('Roxabi/live#2', 'Roxabi/live', 2, json_object('title', 'visible'), 'open');
      INSERT INTO zk_payloads (user_id, issue_key, pubkey_fp, encrypted_payload, updated_at)
      VALUES (1, 'Roxabi/live#1', 'fp1', 'cipher', datetime('now'));
    `);
    scrubDb.exec(readFileSync(join(MIGRATIONS_DIR, "0012_scrub_zk_sealed_payloads.sql"), "utf8"));
    const row1 = scrubDb
      .prepare(`SELECT json_extract(payload, '$.title') AS title FROM issues WHERE key = ?`)
      .get("Roxabi/live#1") as { title: string | null };
    const row2 = scrubDb
      .prepare(`SELECT json_extract(payload, '$.title') AS title FROM issues WHERE key = ?`)
      .get("Roxabi/live#2") as { title: string | null };
    expect(row1.title).toBeNull();
    expect(row2.title).toBe("visible");
    scrubDb.close();
  });
});

describe("edges table and indexes", () => {
  it("has composite primary key (src_key, dst_key, kind)", () => {
    expect(getPkColumns(db, "edges")).toEqual(["src_key", "dst_key", "kind"]);
  });

  it("ix_edges_dst index exists on edges(dst_key)", () => {
    const cols = getIndexColumns(db, "edges", "ix_edges_dst");
    expect(cols).toEqual(["dst_key"]);
  });
});
