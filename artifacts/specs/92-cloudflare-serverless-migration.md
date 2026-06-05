# roxabi-live → Cloudflare Serverless: Migration Spec & Plan

**Option B — locked. TypeScript Workers + D1 + Cron Trigger + Workers-with-assets + Cloudflare Access.**

---

## 0. Decisions & revisions (2026-06-05)

- Interim public access during the rewrite = the **existing Tailscale Funnel** (already restored). No bridge. `live.roxabi.dev` is created once, at cutover (Phase 4).
- **Effort revised to ~10 person-days** (bottom-up slice sum below), down from the 25–35 pd rough estimate in the earlier feasibility pass — the design read the real code (~3,475 active lines; corpus.db is only 2.2 MB / ~2,618 issues).
- **Open Q1 RESOLVED**: v6 frontend static assets exist at `src/roxabi_live/dep_graph/v6/frontend/` (app.js, graph.js, index.html, state.js, … 13 files) — S7 is unblocked; the spec's "frontend/.gitkeep only" worry was incorrect.
- **Open Q3 RESOLVED**: corpus.db = 2.2 MB → standard `wrangler d1 import`, no size-limit concern.
- Remaining open decisions still needing the owner: Q2 (status-field NULLing on first full sync) and Q7 (admin /admin/sync JWT verification) — see §11.

---

## 1. Target Architecture

```
                        Internet
                           │
                    ┌──────▼──────────┐
                    │  Cloudflare CDN  │
                    │  live.roxabi.dev │
                    └──────┬──────────┘
                           │
              ┌────────────▼─────────────┐
              │     Workers-with-assets   │
              │   roxabi-live Worker      │
              │                           │
              │  Route table (in order):  │
              │  /api/*   → fetch handler │
              │  /webhook/*→ fetch handler│
              │  /admin/* → fetch handler │
              │  *        → ASSETS.fetch()│
              └──────┬────────────────────┘
                     │
         ┌───────────┼────────────────┐
         │           │                │
    ┌────▼────┐  ┌───▼──────┐  ┌─────▼──────┐
    │  D1 DB  │  │  GitHub  │  │ CF Access  │
    │(SQLite) │  │ GraphQL  │  │  (OTP)     │
    │         │  │   API    │  │            │
    └─────────┘  └──────────┘  └────────────┘

  Scheduled handler (Cron: "0 * * * *"):
    └─ same Worker binary, scheduled() export
    └─ reads GITHUB_TOKEN + GITHUB_ORG from env
    └─ fetch() → GitHub GraphQL (paginated)
    └─ D1.batch() per page → D1

  Cloudflare Access apps:
    App 1: live.roxabi.dev/*        → OTP (mickael@bouly.io)
    App 2: live.roxabi.dev/webhook/* → Bypass (HMAC sole gate)

  Post-migration M1 state:
    live.service → stopped + disabled
    corpus.db   → archived to ~/.roxabi/roxabi-live/corpus.db.bak
```

---

## 2. D1 Schema — Final DDL

```sql
-- migration: 0001_initial.sql
-- Applied via: wrangler d1 migrations apply DB [--env staging|production]

-- NB: no `PRAGMA journal_mode = WAL` — D1 runs WAL natively and rejects the
-- directive at migration-apply time.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repo_allowlist (
    repo TEXT PRIMARY KEY  -- "owner/name"
);

CREATE TABLE IF NOT EXISTS issues (
    key                 TEXT    PRIMARY KEY,
    repo                TEXT    NOT NULL,
    number              INTEGER NOT NULL,
    title               TEXT,
    state               TEXT    NOT NULL,
    url                 TEXT,
    created_at          TEXT,
    updated_at          TEXT,
    closed_at           TEXT,
    milestone           TEXT,
    is_stub             INTEGER NOT NULL DEFAULT 0,
    lane                TEXT,
    priority            TEXT,
    size                TEXT,
    status              TEXT,
    has_active_branch   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS labels (
    issue_key   TEXT NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (issue_key, name),
    FOREIGN KEY (issue_key) REFERENCES issues(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
    src_key     TEXT NOT NULL,
    dst_key     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'parent',
    PRIMARY KEY (src_key, dst_key, kind)
);

CREATE TABLE IF NOT EXISTS sync_state (
    repo            TEXT PRIMARY KEY,
    last_cursor     TEXT,
    last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS pr_state (
    repo                TEXT    NOT NULL,
    number              INTEGER NOT NULL,
    state               TEXT    NOT NULL,
    has_reviewed_label  INTEGER NOT NULL DEFAULT 0,
    closing_issue_keys  TEXT,
    updated_at          TEXT    NOT NULL,
    PRIMARY KEY (repo, number)
);

-- sync_control: reconciler state (replaces asyncio module-level vars)
CREATE TABLE IF NOT EXISTS sync_control (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO sync_control VALUES ('auth_failures',   '0', datetime('now'));
INSERT OR IGNORE INTO sync_control VALUES ('halted',          '0', datetime('now'));
INSERT OR IGNORE INTO sync_control VALUES ('sync_running',    '0', datetime('now'));
INSERT OR IGNORE INTO sync_control VALUES ('sync_started_at', '', datetime('now'));

-- Indices (mirror Python schema.py exactly)
CREATE INDEX IF NOT EXISTS ix_edges_dst        ON edges(dst_key);
CREATE INDEX IF NOT EXISTS ix_issues_repo_state ON issues(repo, state);
CREATE INDEX IF NOT EXISTS ix_labels_name       ON labels(name);
CREATE INDEX IF NOT EXISTS ix_pr_state_state    ON pr_state(state);
```

**Key index decisions:**
- `ix_edges_dst` — graph query joins on `dst_key` (blockers lookup)
- `ix_issues_repo_state` — `/api/issues?repo=X&state=open` filter
- `ix_labels_name` — filter by label in graph builder
- `ix_pr_state_state` — graph builder reads only `state='open'`

**`/api/version` query:** `SELECT MAX(last_synced_at) AS ts FROM sync_state` — no extra table needed.

---

## 3. Worker Topology & wrangler.toml

### Repo layout (new `worker/` subtree alongside existing `src/`)

```
roxabi-live/
├── worker/
│   ├── src/
│   │   ├── index.ts          # fetch + scheduled exports
│   │   ├── router.ts         # Hono v4 app, API routes
│   │   ├── sync/
│   │   │   ├── graphql.ts    # fetch() GraphQL transport
│   │   │   ├── sync.ts       # org-wide sync, page-level batching
│   │   │   └── queries.ts    # ISSUES_QUERY, PRS_QUERY, REFS_QUERY, …
│   │   ├── webhook/
│   │   │   ├── hmac.ts       # Web Crypto HMAC-SHA256 verify
│   │   │   └── handlers.ts   # issues, deps, sub_issues, ref, pr
│   │   ├── api/
│   │   │   ├── issues.ts     # GET /api/issues, GET /api/issues/:key
│   │   │   ├── graph.ts      # GET /api/graph (v6 port)
│   │   │   └── version.ts    # GET /api/version
│   │   └── types.ts          # Env interface, shared types
│   ├── migrations/
│   │   └── 0001_initial.sql  # DDL above
│   ├── tsconfig.json
│   └── package.json
├── frontend/                 # Static assets (served via ASSETS binding)
│   └── .gitkeep              # NOTE: v6 frontend assets exist at src/roxabi_live/dep_graph/v6/frontend/ — copy to frontend/ in S7
├── src/roxabi_live/          # Python — frozen, removed post-cutover
└── wrangler.toml
```

### wrangler.toml (canonical)

```toml
name = "roxabi-live"
main = "worker/src/index.ts"
compatibility_date = "2025-01-01"
# NO nodejs_compat — Web Crypto is available natively in Workers runtime

[assets]
directory = "./frontend"
binding   = "ASSETS"

[triggers]
crons = ["0 * * * *"]

[[d1_databases]]
binding        = "DB"
database_name  = "roxabi-live-production"
database_id    = "<PROD_D1_ID>"     # fill after: wrangler d1 create roxabi-live-production
migrations_dir = "worker/migrations"

# ── Staging environment ──────────────────────────────────────────────────────

[env.staging]
name = "roxabi-live-staging"

[[env.staging.d1_databases]]
binding        = "DB"
database_name  = "roxabi-live-staging"
database_id    = "<STAGING_D1_ID>"  # fill after: wrangler d1 create roxabi-live-staging
migrations_dir = "worker/migrations"

[env.staging.triggers]
crons = ["0 * * * *"]
```

### Worker entry point structure (worker/src/index.ts)

```typescript
import { Hono } from "hono";
import { app } from "./router";
import { runSync } from "./sync/sync";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_TOKEN: string;
  GITHUB_ORG: string;
  GITHUB_WEBHOOK_SECRET: string;  // different value per env (staging vs prod)
}

// fetch handler: API routes first, then static assets
export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runSync(env));
  },
};
```

### router.ts — route order (API before ASSETS)

```typescript
import { Hono } from "hono";
import { Env } from "./types";
import { issuesRoutes } from "./api/issues";
import { graphRoutes }  from "./api/graph";
import { versionRoute } from "./api/version";
import { webhookRoute } from "./webhook/handlers";
import { adminRoutes }  from "./api/admin";

const app = new Hono<{ Bindings: Env }>();

// API — evaluated before ASSETS fallback
app.route("/api/issues", issuesRoutes);
app.route("/api/graph",  graphRoutes);
app.get("/api/version",  versionRoute);
app.post("/webhook/github", webhookRoute);
app.route("/admin",      adminRoutes);      // POST /admin/sync (OTP-gated)

// Static assets fallback — last resort
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export { app };
```

---

## 4. Sync Rewrite

### 4.1 GraphQL transport (worker/src/sync/graphql.ts)

```typescript
const GH_GRAPHQL_URL = "https://api.github.com/graphql";

export class GraphQLError extends Error {}

export async function ghGraphQL(
  query: string,
  variables: Record<string, unknown>,
  token: string
): Promise<Record<string, unknown>> {
  const resp = await fetch(GH_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "roxabi-live/1.0",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    // Detect auth errors for halt logic
    if (resp.status === 401 || resp.status === 403) {
      const err = new GraphQLError(`GitHub auth error ${resp.status}: ${text.slice(0, 200)}`);
      (err as any).isAuth = true;
      throw err;
    }
    throw new GraphQLError(`GitHub HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json() as Record<string, unknown>;
  if (json.errors) {
    throw new GraphQLError(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json;
}
```

**Queries** (worker/src/sync/queries.ts) — copied verbatim from Python `graphql.py`:
- `ISSUES_QUERY` — same fields (number, title, state, url, createdAt, updatedAt, closedAt, milestone, labels, subIssues, parent, blockedBy, blocking)
- `REPOS_QUERY` — same (name, owner.login, isArchived, isPrivate)
- `REFS_QUERY` — same (refs/heads/, first: 100)
- `PRS_QUERY` — same (OPEN, first: 50, closingIssuesReferences, labels)
- `STUB_ISSUE_QUERY` — same
- `SINGLE_ISSUE_DEPS_QUERY` — same

### 4.2 Concurrency guard — D1 advisory lock

Cloudflare does not hard-guarantee single-concurrent Cron execution. Two Workers may overlap at a scheduling boundary. Advisory lock in `sync_control` prevents double-run:

```typescript
async function acquireSyncLock(db: D1Database): Promise<boolean> {
  // Atomic: claim lock only if not running OR stale (>900s — handles crashed invocation)
  const result = await db.prepare(`
    UPDATE sync_control
    SET value = '1', updated_at = ?
    WHERE key = 'sync_running'
      AND (value = '0' OR (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', updated_at) AS INTEGER)) > 900)
  `).bind(new Date().toISOString()).run();
  return result.meta.changes > 0;
}

async function releaseSyncLock(db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE sync_control SET value='0', updated_at=? WHERE key='sync_running'`
  ).bind(new Date().toISOString()).run();
}
```

### 4.3 Auth-halt (replaces asyncio module globals)

```typescript
async function getAuthFailures(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `SELECT value FROM sync_control WHERE key='auth_failures'`
  ).first<{value: string}>();
  return parseInt(row?.value ?? "0", 10);
}

async function isHalted(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    `SELECT value FROM sync_control WHERE key='halted'`
  ).first<{value: string}>();
  return row?.value === "1";
}

async function incrementAuthFailures(db: D1Database): Promise<number> {
  await db.prepare(`
    UPDATE sync_control SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT), updated_at=?
    WHERE key='auth_failures'
  `).bind(new Date().toISOString()).run();
  return getAuthFailures(db);
}

async function haltSync(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE sync_control SET value='1', updated_at=? WHERE key='halted'`)
      .bind(new Date().toISOString()),
    // Notify endpoint or log — see Section 4.6
  ]);
}

async function resetAuthFailures(db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE sync_control SET value='0', updated_at=? WHERE key='auth_failures'`
  ).bind(new Date().toISOString()).run();
}
```

### 4.4 Main sync loop (worker/src/sync/sync.ts)

**Critical constraint: D1 hard limit = 1000 subrequests per Worker invocation.**
- Each `db.batch()` call = 1 subrequest.
- Each `fetch()` to GitHub = 1 subrequest.
- Budget: ~26 fetch calls (26 pages × 100 issues) + ~26 D1 batches (issues+labels per page) + ~N repo/branch/PR queries + stub fetches. Stays well under 1000 for typical Roxabi org size.

**Two-pass edge write** — prevents cross-page FK ordering hazard (issue rows must exist before edges reference them):

```typescript
export async function runSync(env: Env): Promise<void> {
  const db = env.DB;

  // Pre-flight: check halt
  if (await isHalted(db)) {
    console.log("[sync] halted — skipping");
    return;
  }

  // Advisory lock
  if (!(await acquireSyncLock(db))) {
    console.log("[sync] lock held by another invocation — skipping");
    return;
  }

  try {
    await db.prepare(
      `UPDATE sync_control SET value=?, updated_at=? WHERE key='sync_started_at'`
    ).bind(new Date().toISOString(), new Date().toISOString()).run();

    const repos = await getRepoAllowlist(db);
    if (repos.length === 0) {
      console.warn("[sync] repo_allowlist empty — nothing to sync");
      return;
    }

    // Enumerate org repos (filtered by allowlist)
    const orgRepos = await enumerateOrgRepos(env.GITHUB_ORG, env.GITHUB_TOKEN);
    const active = orgRepos.filter(r => repos.includes(`${r.owner}/${r.name}`));

    // Pass 1: sync issues + labels for all repos
    // Collect edge data during pass 1, flush in pass 2
    const collectedEdges = new Map<string, EdgeData>();

    for (const { owner, name } of active) {
      await syncRepoIssues(db, env.GITHUB_TOKEN, owner, name, collectedEdges);
    }

    // Pass 2: flush all edges in chunked batches (≤900 stmts per batch)
    await flushEdges(db, collectedEdges);

    // Branch + PR state (per repo)
    for (const { owner, name } of active) {
      await syncBranches(db, env.GITHUB_TOKEN, owner, name);
      await syncPRs(db, env.GITHUB_TOKEN, owner, name);
    }

    // Closed-hop pass: stub-fetch orphan edge endpoints
    await closedHopPass(db, env.GITHUB_TOKEN);

    await resetAuthFailures(db);
    console.log("[sync] completed successfully");

  } catch (err) {
    const isAuth = (err as any).isAuth === true;
    if (isAuth) {
      const failures = await incrementAuthFailures(db);
      console.error(`[sync] auth failure ${failures}/2`);
      if (failures >= 2) {
        await haltSync(db);
        console.error("[sync] HALTED: 2 consecutive auth failures");
        // POST to NOTIFY_URL if configured
        if ((env as any).NOTIFY_URL) {
          await fetch((env as any).NOTIFY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "sync_halted", ts: new Date().toISOString() }),
          }).catch(() => {});
        }
      }
    } else {
      console.error("[sync] error:", err);
    }
  } finally {
    await releaseSyncLock(db);
  }
}
```

### 4.5 Page-level batching (syncRepoIssues)

```typescript
async function syncRepoIssues(
  db: D1Database,
  token: string,
  owner: string,
  name: string,
  collectedEdges: Map<string, EdgeData>
): Promise<void> {
  const repo = `${owner}/${name}`;
  let cursor: string | null = null;
  let pages = 0;

  while (true) {
    const response = await ghGraphQL(ISSUES_QUERY, { owner, name, cursor, since: null }, token);
    const data = (response.data as any);
    const rateLimit = data.rateLimit;
    console.log(`[sync] ${repo} p${pages+1} cost=${rateLimit.cost} remaining=${rateLimit.remaining}`);

    const issuesPage = data.repository.issues;
    const nodes: any[] = issuesPage.nodes;

    // Collect ALL D1 statements for this page into one batch
    const pageStmts: D1PreparedStatement[] = [];

    for (const node of nodes) {
      const key = `${repo}#${node.number}`;
      const labels: string[] = node.labels.nodes.map((l: any) => l.name);
      const derived = extractFromLabels(labels);

      // Issue upsert — FULL path (updates status)
      pageStmts.push(db.prepare(UPSERT_ISSUE_SQL).bind(
        key, repo, node.number, node.title,
        node.state.toLowerCase(), node.url,
        node.createdAt, node.updatedAt, node.closedAt,
        node.milestone?.title ?? null,
        0,  // is_stub
        derived.lane, derived.priority, derived.size,
        null,  // status — GraphQL sync sets null; Project v2 board manages this
        0      // has_active_branch — set by branch pass below
      ));

      // Label wipe+rewrite
      pageStmts.push(db.prepare("DELETE FROM labels WHERE issue_key=?").bind(key));
      for (const lbl of labels) {
        pageStmts.push(db.prepare("INSERT OR IGNORE INTO labels VALUES (?,?)").bind(key, lbl));
      }

      // Collect edges (do NOT flush here — cross-page ordering hazard)
      collectEdges(node, repo, key, collectedEdges);
    }

    // One D1 subrequest for the entire page
    await db.batch(pageStmts);

    // Update sync_state cursor
    await db.prepare(
      "INSERT OR REPLACE INTO sync_state(repo, last_cursor, last_synced_at) VALUES (?,?,?)"
    ).bind(repo, null, new Date().toISOString()).run();

    pages++;
    const pageInfo = issuesPage.pageInfo;
    if (!pageInfo.hasNextPage || pages >= 500) break;
    cursor = pageInfo.endCursor;
    if (!cursor) break;
  }
}
```

### 4.6 Two-pass edge flush (flushEdges)

```typescript
async function flushEdges(
  db: D1Database,
  collectedEdges: Map<string, EdgeData>
): Promise<void> {
  const allEdgeStmts: D1PreparedStatement[] = [];

  for (const [issueKey, { parents, children, blockedBy, blocking }] of collectedEdges) {
    // Delete existing edges of each kind for this issue (both as src and dst)
    allEdgeStmts.push(
      db.prepare("DELETE FROM edges WHERE (src_key=? OR dst_key=?) AND kind='parent'")
        .bind(issueKey, issueKey)
    );
    allEdgeStmts.push(
      db.prepare("DELETE FROM edges WHERE (src_key=? OR dst_key=?) AND kind='blocks'")
        .bind(issueKey, issueKey)
    );

    for (const p of parents) {
      allEdgeStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'parent')").bind(p, issueKey)
      );
    }
    for (const c of children) {
      allEdgeStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'parent')").bind(issueKey, c)
      );
    }
    for (const b of blockedBy) {
      allEdgeStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'blocks')").bind(b, issueKey)
      );
    }
    for (const bl of blocking) {
      allEdgeStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'blocks')").bind(issueKey, bl)
      );
    }
  }

  // Chunk into ≤900-stmt batches to stay under 1000 subrequest limit per invocation
  for (let i = 0; i < allEdgeStmts.length; i += 900) {
    await db.batch(allEdgeStmts.slice(i, i + 900));
  }
}
```

### 4.7 Branch sync — chunked IN/NOT IN

```typescript
async function syncBranches(
  db: D1Database, token: string, owner: string, name: string
): Promise<void> {
  const repo = `${owner}/${name}`;
  const matchedNumbers: number[] = [];
  let cursor: string | null = null;

  while (true) {
    const resp = await ghGraphQL(REFS_QUERY, { owner, name, cursor }, token);
    const refs = (resp.data as any).repository.refs;
    for (const node of refs.nodes) {
      const m = /^(?:[a-z]+\/)?(\d+)-/.exec(node.name);
      if (m) matchedNumbers.push(parseInt(m[1], 10));
    }
    if (!refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
    if (!cursor) break;
  }

  if (matchedNumbers.length > 0) {
    // Chunk at ≤90 to stay within D1 parameter limits (max ~100)
    for (let i = 0; i < matchedNumbers.length; i += 90) {
      const chunk = matchedNumbers.slice(i, i + 90);
      const ph = chunk.map(() => "?").join(",");
      await db.prepare(
        `UPDATE issues SET has_active_branch=1 WHERE repo=? AND number IN (${ph})`
      ).bind(repo, ...chunk).run();
    }
    // Reset all non-matched issues in this repo
    // Cannot use NOT IN with large sets — iterate and zero the rest
    // Simplest safe approach: reset all first, then set matched
    await db.prepare(
      "UPDATE issues SET has_active_branch=0 WHERE repo=?"
    ).bind(repo).run();
    // Re-apply set (after reset)
    for (let i = 0; i < matchedNumbers.length; i += 90) {
      const chunk = matchedNumbers.slice(i, i + 90);
      const ph = chunk.map(() => "?").join(",");
      await db.prepare(
        `UPDATE issues SET has_active_branch=1 WHERE repo=? AND number IN (${ph})`
      ).bind(repo, ...chunk).run();
    }
  } else {
    await db.prepare(
      "UPDATE issues SET has_active_branch=0 WHERE repo=?"
    ).bind(repo).run();
  }
}
```

### 4.8 Two SQL constants (webhook vs full sync)

```typescript
// Full sync path — updates ALL columns including status
// status is set to null here (Project v2 board manages it; sync doesn't carry it)
const UPSERT_ISSUE_SQL = `
  INSERT INTO issues
    (key, repo, number, title, state, url, created_at, updated_at,
     closed_at, milestone, is_stub, lane, priority, size, status, has_active_branch)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET
    repo=excluded.repo, number=excluded.number, title=excluded.title,
    state=excluded.state, url=excluded.url, created_at=excluded.created_at,
    updated_at=excluded.updated_at, closed_at=excluded.closed_at,
    milestone=excluded.milestone, is_stub=excluded.is_stub,
    lane=excluded.lane, priority=excluded.priority, size=excluded.size,
    status=excluded.status, has_active_branch=excluded.has_active_branch
`;

// Webhook path — preserves existing status (Project v2 board state must not be clobbered)
// has_active_branch intentionally NOT in ON CONFLICT SET (managed by branch sync only)
const UPSERT_ISSUE_FROM_WEBHOOK_SQL = `
  INSERT INTO issues
    (key, repo, number, title, state, url, created_at, updated_at,
     closed_at, milestone, is_stub, lane, priority, size, status, has_active_branch)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,NULL,0)
  ON CONFLICT(key) DO UPDATE SET
    repo=excluded.repo, number=excluded.number, title=excluded.title,
    state=excluded.state, url=excluded.url, created_at=excluded.created_at,
    updated_at=excluded.updated_at, closed_at=excluded.closed_at,
    milestone=excluded.milestone, is_stub=excluded.is_stub,
    lane=excluded.lane, priority=excluded.priority, size=excluded.size
`;
```

### 4.9 HMAC verification (webhook/hmac.ts)

```typescript
export async function verifyHmac(
  body: ArrayBuffer,
  header: string | null,
  secret: string
): Promise<boolean> {
  // Null-safe: missing or wrong-prefix header → reject
  if (!header?.startsWith("sha256=")) return false;

  const hexPart = header.slice(7);
  const hexBytes = hexPart.match(/.{2}/g) ?? [];
  // Must be exactly 32 bytes (SHA-256 = 256 bits = 32 bytes = 64 hex chars)
  if (hexBytes.length !== 32) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sig = Uint8Array.from(hexBytes.map(b => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, sig, body);
}
```

---

## 5. Cutover & Rollback Runbook

### Phase 1 — D1 bootstrap & data import

```bash
# Create databases
wrangler d1 create roxabi-live-production
wrangler d1 create roxabi-live-staging
# → Copy IDs into wrangler.toml [[d1_databases]] entries

# Apply migrations (staging first)
wrangler d1 migrations apply DB --env staging
wrangler d1 migrations apply DB

# Snapshot corpus.db from M1 (WAL checkpoint first to ensure consistent read)
ssh roxabituwer "sqlite3 ~/.roxabi/corpus.db 'PRAGMA wal_checkpoint(TRUNCATE);'"
scp roxabituwer:~/.roxabi/corpus.db /tmp/corpus_snapshot.db

# Import to staging D1
wrangler d1 import DB /tmp/corpus_snapshot.db --env staging

# Import to production D1
wrangler d1 import DB /tmp/corpus_snapshot.db

# Verify row counts match
sqlite3 /tmp/corpus_snapshot.db "SELECT COUNT(*) FROM issues;"
wrangler d1 execute DB --env staging --command "SELECT COUNT(*) FROM issues;"
wrangler d1 execute DB --command "SELECT COUNT(*) FROM issues;"
```

### Phase 2 — Worker deploy (staging)

```bash
cd worker && npm install
cd ..

# Set secrets (staging)
wrangler secret put GITHUB_TOKEN --env staging        # PAT with read:org, repo
wrangler secret put GITHUB_ORG --env staging          # "Roxabi"
wrangler secret put GITHUB_WEBHOOK_SECRET --env staging  # staging-specific secret

# Deploy to staging
wrangler deploy --env staging

# Verify
curl https://roxabi-live-staging.<account>.workers.dev/api/version
curl https://roxabi-live-staging.<account>.workers.dev/api/graph | jq '.nodes | length'

# Trigger a manual sync on staging
curl -X POST https://roxabi-live-staging.<account>.workers.dev/admin/sync \
  -H "CF-Access-Jwt-Assertion: <token>"  # OTP flow
```

### Phase 3 — Smoke test production worker

```bash
# Set secrets (production)
wrangler secret put GITHUB_TOKEN                # same PAT or dedicated prod PAT
wrangler secret put GITHUB_ORG                 # "Roxabi"
wrangler secret put GITHUB_WEBHOOK_SECRET      # DIFFERENT value from staging

# Deploy to production
wrangler deploy

# Verify production worker (workers.dev URL, not live.roxabi.dev yet)
curl https://roxabi-live.<account>.workers.dev/api/version
curl https://roxabi-live.<account>.workers.dev/api/graph | jq '.nodes | length'

# Compare node count with current M1 Tailscale Funnel (must be ≥ M1 count)
curl https://roxabituwer.goose-logarithm.ts.net/api/graph | jq '.nodes | length'   # M1 via Tailscale Funnel
curl https://roxabi-live.<account>.workers.dev/api/graph | jq '.nodes | length'    # Worker
```

### Go/No-Go Checklist (before Phase 4 DNS cutover)

```
[ ] Worker /api/graph node count ≥ M1 node count (compare vs Tailscale Funnel URL)
[ ] Worker /api/version returns ISO timestamp within last 2h
[ ] Worker /health (or /api/version) returns 200
[ ] Cron trigger fired at least once: `SELECT MAX(last_synced_at) FROM sync_state` returns a timestamp within last 2h
[ ] Webhook HMAC verify passes: test delivery from GitHub → staging endpoint OK
[ ] Cloudflare Logpush configured → R2 bucket (persistent log storage for audit)
[ ] CF Access OTP tested: mickael@bouly.io receives code, dashboard loads
[ ] CF Access Bypass on /webhook/* confirmed: no OTP prompt on webhook URL
[ ] Admin /admin/sync endpoint tested (manual trigger works behind OTP)
[ ] Staging sync_control.halted = '0' (not halted)
```

**STOP if any item is unchecked. Do not proceed to Phase 4.**

### Phase 4 — DNS cutover

```bash
# In Cloudflare dashboard:
# 1. Add live.roxabi.dev zone (or delegate subdomain) to Cloudflare if not yet present
# 2. Create CF Access apps (was S0/bridge step — folded here):
#    a. Add OTP identity provider (Email OTP, free)
#    b. Create App 1: live.roxabi.dev (all paths) → Allow mickael@bouly.io
#    c. Create App 2: live.roxabi.dev/webhook/* → Bypass
# 3. Add Worker custom domain: live.roxabi.dev/* → roxabi-live worker
#    (Workers & Pages → Custom Domains → Add Custom Domain)
# OR via wrangler:
wrangler deploy --route "live.roxabi.dev/*"

# Wait for DNS propagation (~30s for CF zones)
curl -I https://live.roxabi.dev/api/version   # must return CF-Ray header

# Update GitHub org webhook URL:
# Settings → Webhooks → live.roxabi.dev/webhook/github → update secret to prod value
```

### Phase 5 — M1 decommission

```bash
# M1: stop and disable live.service
systemctl --user stop live.service
systemctl --user disable live.service

# Archive corpus.db
cp ~/.roxabi/corpus.db ~/.roxabi/corpus.db.bak.$(date +%Y%m%d)

# Verify everything routes through CF Worker
curl https://live.roxabi.dev/api/version
curl https://live.roxabi.dev/api/graph | jq '.nodes | length'
```

### Rollback procedure (any phase before Phase 5)

```bash
# Re-enable M1 live.service (if stopped in error)
systemctl --user start live.service

# Access M1 via existing Tailscale Funnel URL during rollback
# https://roxabituwer.goose-logarithm.ts.net

# Revert DNS: remove Worker custom domain
# (CF dashboard: Workers & Pages → roxabi-live → Custom Domains → Remove)
```

After Phase 5 (M1 decommissioned): rollback requires re-deploying from git + new D1 import. Target RTO ~30 min.

---

## 6. Repo Layout, CI & Secrets

### Final repo layout

```
roxabi-live/
├── worker/
│   ├── src/
│   │   ├── index.ts
│   │   ├── router.ts
│   │   ├── types.ts
│   │   ├── sync/
│   │   │   ├── graphql.ts
│   │   │   ├── queries.ts
│   │   │   └── sync.ts
│   │   ├── webhook/
│   │   │   ├── hmac.ts
│   │   │   └── handlers.ts
│   │   └── api/
│   │       ├── issues.ts
│   │       ├── graph.ts
│   │       ├── version.ts
│   │       └── admin.ts
│   ├── migrations/
│   │   └── 0001_initial.sql
│   ├── tsconfig.json
│   └── package.json          # hono, @cloudflare/workers-types, vitest
├── frontend/                  # static assets (v6 assets from src/roxabi_live/dep_graph/v6/frontend/ — copy in S7)
├── src/roxabi_live/           # Python — kept until Phase 5, then removed
├── wrangler.toml
├── .github/workflows/
│   └── ci.yml                 # unified: test → deploy (single file)
└── tools/
    └── file_exemptions.txt    # existing Python quality gate exemptions
```

### CI workflow (.github/workflows/ci.yml)

Single file with `deploy` job gated on `test` job — prevents deploy/test race:

```yaml
name: CI

on:
  push:
    branches: [staging, main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install uv && uv sync
      - run: uv run pytest
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: cd worker && npm ci
      - run: cd worker && npm test          # vitest

  deploy:
    needs: test                              # gates deploy on ALL tests passing
    if: github.event_name == 'push' && (github.ref_name == 'staging' || github.ref_name == 'main')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: cd worker && npm ci
      - name: Deploy staging
        if: github.ref_name == 'staging'
        run: npx wrangler deploy --env staging
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
      - name: Deploy production
        if: github.ref_name == 'main'
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

### Secrets inventory

| Location | Secret | Value |
|---|---|---|
| GitHub repo secrets | `CF_API_TOKEN` | Cloudflare API token (Workers:Edit, D1:Edit scope) |
| `wrangler secret put` (staging) | `GITHUB_TOKEN` | PAT: `read:org, repo, read:user` |
| `wrangler secret put` (staging) | `GITHUB_ORG` | `Roxabi` |
| `wrangler secret put` (staging) | `GITHUB_WEBHOOK_SECRET` | staging-specific value (≠ prod) |
| `wrangler secret put` (prod) | `GITHUB_TOKEN` | same or dedicated prod PAT |
| `wrangler secret put` (prod) | `GITHUB_ORG` | `Roxabi` |
| `wrangler secret put` (prod) | `GITHUB_WEBHOOK_SECRET` | prod value (update GitHub webhook delivery) |
| `wrangler secret put` (prod, optional) | `NOTIFY_URL` | Webhook/ntfy URL for halt alerts |

**Note:** `GITHUB_WEBHOOK_SECRET` must be different between staging and production. GitHub org webhooks deliver to one URL — ensure production URL uses production secret only.

---

## 7. Cloudflare Access Config

### Two Zero Trust Applications

**App 1 — Dashboard (all paths)**

```
Application type: Self-hosted
Application name: roxabi-live
Application domain: live.roxabi.dev
Path: (leave blank = matches all paths)
Session duration: 24h

Identity providers: One-time PIN (OTP) only
  - Email: mickael@bouly.io
  - (free tier ≤ 50 seats)

Policy:
  Name: Allow Mickael
  Action: Allow
  Rule: Emails → mickael@bouly.io
```

**App 2 — Webhook bypass (path-scoped)**

```
Application type: Self-hosted
Application name: roxabi-live-webhook
Application domain: live.roxabi.dev
Path: /webhook/*            ← CRITICAL: path-scoped bypass
Session duration: n/a

Policy:
  Name: Bypass
  Action: Bypass
  Rule: Everyone
```

**Note:** The Bypass policy means `/webhook/*` is publicly reachable — HMAC-SHA256 remains the sole gate. App 2 must be created BEFORE configuring GitHub webhook delivery.

**CF Access JWT validation** (optional, for `/admin/*`): Worker can extract `CF-Access-Jwt-Assertion` header and verify it against the JWKS endpoint if additional server-side validation is desired. Minimum viable: rely on Access policy enforcement at the edge.

---

## 8. Sliced Implementation Plan

| # | Slice | Scope | New/changed files | Effort (d) | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| S1 | Worker scaffold | wrangler.toml; Hono router; /health + /api/version stubs; D1 migrations applied | `worker/src/index.ts`, `router.ts`, `types.ts`, `api/version.ts`, `wrangler.toml`, `worker/migrations/0001_initial.sql` | 1 | — | `wrangler deploy --env staging` succeeds; `/api/version` returns 200; D1 tables exist; CI deploy job green |
| S2 | D1 import | corpus.db WAL-checkpoint → `wrangler d1 import` to staging + production | — (ops, no code) | 0.5 | S1 | D1 row counts match sqlite3 source counts for issues, edges, labels, sync_state |
| S3 | GraphQL transport + queries | `fetch()` replacing `subprocess gh api graphql`; all 6 query strings ported | `worker/src/sync/graphql.ts`, `worker/src/sync/queries.ts` | 1 | S1 | Unit tests: mock `fetch`, assert correct Authorization header; GraphQL error → GraphQLError thrown; auth error sets `.isAuth=true` |
| S4 | Sync engine | Full sync loop: concurrency lock, auth-halt, page-level batching, two-pass edge flush, branch sync (chunked), PR sync, closed-hop pass | `worker/src/sync/sync.ts` | 2 | S2, S3 | Manual `/admin/sync` trigger completes without error; D1 issue count ≥ pre-import count; `sync_control.halted` = '0'; `sync_state.last_synced_at` updated; no subrequest limit errors in CF logs |
| S5 | Webhook handlers | HMAC verify (null-safe); issues/deps/sub_issues/ref_create/ref_delete/pull_request; two SQL constants (full vs webhook) | `worker/src/webhook/hmac.ts`, `worker/src/webhook/handlers.ts` | 1.5 | S3 | Test delivery from GitHub repo webhooks → staging endpoint; HMAC mismatch → 403; correct actions update D1 rows; `status` preserved on webhook upsert |
| S6 | API endpoints | GET /api/issues (list + filter), GET /api/issues/:key, GET /api/graph (v6 port: labels, PRs, issues, edges; _compute_dev_state TS port; milestone parse TS port), POST /admin/sync | `worker/src/api/issues.ts`, `worker/src/api/graph.ts`, `worker/src/api/admin.ts` | 2 | S2, S4 | `/api/graph` response structure matches Python output (nodes, edges, all fields present); `/api/issues` filters work; `/admin/sync` triggers sync and returns 202 |
| S7 | Frontend wiring | Copy v6 frontend static assets from `src/roxabi_live/dep_graph/v6/frontend/` to `frontend/`; verify Workers-with-assets serves them at `/`; update any hardcoded API base URL | `frontend/**` | 1 | S1, S6 | `curl https://roxabi-live.<account>.workers.dev/` returns HTML; dep-graph tab renders with data from `/api/graph`; filter tabs persist via sessionStorage |
| S8 | Cron + observability | Verify Cron trigger fires hourly in production; Logpush → R2 configured; NOTIFY_URL secret wired; `/api/version` reflects latest sync | — (CF dashboard config) | 0.5 | S4 | CF dashboard shows at least 1 successful Cron execution; R2 bucket receives log entries; `/api/version` timestamp ≤ 65 min old after 1h |
| S9 | Cutover | CF Access apps created (App 1 OTP + App 2 webhook bypass); go/no-go checklist; DNS cutover (Worker custom domain `live.roxabi.dev`); M1 decommission | — (ops) | 0.5 | S5, S6, S7, S8 + all go/no-go items checked | `live.roxabi.dev/api/graph` returns CF-Ray header; M1 live.service stopped; node count stable |

**Total effort: ~10 d** (solo operator, includes ops slices)

---

## 9. ~~Bridge Now~~ — section removed

This section was dropped per the 2026-06-05 decision: the existing Tailscale Funnel (`https://roxabituwer.goose-logarithm.ts.net`) provides interim public access during the rewrite. No Cloudflare Tunnel bridge will be built. `live.roxabi.dev` is created once, at Phase 4 cutover. CF Access app creation (previously in this section) is folded into S9 scope.

---

## 10. Top Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| D1 subrequest limit (1000/invocation) exceeded on large org sync | Medium | Sync fails silently | Page-level batching (1 `db.batch()` per GraphQL page); monitor CF dashboard subrequest count per invocation; reduce page size to 50 if needed |
| GraphQL rate limit (5000 points/h) exhausted during full re-sync | Low-Medium | Sync halted for up to 1h | Log `rateLimit.cost` per page; measure actual cost in staging before prod cutover; consider incremental `since` cursor to reduce point spend |
| Duplicate Cron invocation (CF schedule jitter) | Low | Double-writes to D1 (idempotent) OR wasted GitHub API quota | D1 advisory lock with 900s stale TTL; idempotent UPSERT pattern means double-run is safe, just wasteful |
| Frontend static assets not in repo (`frontend/.gitkeep`) | ~~High~~ RESOLVED | S7 blocked | Assets confirmed at `src/roxabi_live/dep_graph/v6/frontend/` (13 files) — copy to `frontend/` in S7 |
| Webhook HMAC secret rotation drift (staging ≠ prod) | Medium | Prod webhooks rejected after staging test delivery changes secret | Keep secrets in separate `wrangler secret put` per env; document rotation procedure; test each env independently |
| M1 decommission before Logpush configured | Medium | Log loss — no audit trail for prod | Logpush → R2 is a hard go/no-go gate in Phase 4 checklist; do not proceed to Phase 5 without it |
| D1 import fails on WAL-mode corpus.db | Low | No baseline data in D1 | `PRAGMA wal_checkpoint(TRUNCATE)` before `scp`; verify row counts post-import |
| `wrangler d1 import` limits on large DB | ~~Low~~ RESOLVED | Import truncated | corpus.db = 2.2 MB — standard `wrangler d1 import` applies, no chunking needed |
| CF Access OTP email delay | Low | Locked out briefly | Test before Phase 4; have direct workers.dev fallback URL available |
| Cron CPU budget (15 min/invocation) exceeded | Low | Sync killed mid-run | Monitor execution time in CF logs; advisory lock `updated_at` reflects start time; 900s TTL resets it if exceeded |

---

## 11. Open Questions / Not Yet Designed

| # | Question | Impact | Owner action |
|---|---|---|---|
| 1 | ~~**Frontend assets location**: `frontend/.gitkeep` only — v6 static assets not checked into repo. Are they at `src/roxabi_live/dep_graph/v6/frontend/`? Built at runtime? Need to confirm source and add to `frontend/` or add a build step.~~ **✅ RESOLVED (2026-06-05)**: Assets confirmed at `src/roxabi_live/dep_graph/v6/frontend/` — 13 files including app.js, graph.js, index.html, state.js. S7 is unblocked; copy to `frontend/` in S7. | S7 unblocked | Done |
| 2 | **`status` field source**: Full sync sets `status=NULL` (Project v2 board manages it). D1 import preserves existing values. But after first full sync post-cutover, all `status` values will be NULLed. Is a Project v2 → D1 sync needed, or is `status` display-only on the dashboard? | Data fidelity | Decide: accept NULL status on first sync cycle, or add Project v2 GraphQL query to sync loop |
| 3 | ~~**`wrangler d1 import` file size limit**: corpus.db current size unknown. If >100MB, import method changes.~~ **✅ RESOLVED (2026-06-05)**: corpus.db = 2.2 MB — standard `wrangler d1 import` applies. | Resolved | Done |
| 4 | **GitHub PAT scopes for Workers**: Current `gh` CLI auth token has `read:org, repo`. A service PAT (vs user PAT) is needed for production. Confirm required scopes and create dedicated PAT. | S3/S4 | Create `Roxabi` org service PAT; scopes: `read:org`, `repo`, `read:user` (for subIssues/blockedBy — requires GH Issues beta) |
| 5 | **`blocking`/`blockedBy` GraphQL availability**: These fields require GitHub Issues opt-in beta for the org. Confirm `Roxabi` org has the Issues beta enabled (it does if current sync works — but verify the PAT retains access). | S3 | Verify with a test GraphQL query using new PAT |
| 6 | **Logpush R2 bucket**: R2 bucket for Cloudflare Logpush not yet created. Required before Phase 4. | Go/no-go gate | `wrangler r2 bucket create roxabi-live-logs`; configure Logpush in CF dashboard |
| 7 | **Admin /admin/sync endpoint auth**: Current design relies on CF Access OTP at the edge. Should the Worker additionally verify the CF Access JWT to prevent bypass? | Security | Decide: edge Access policy is sufficient (CF-managed), or add JWT verification in handler |
| 8 | **`repo_allowlist` seeding in D1**: D1 import brings existing allowlist rows. But if allowlist is empty (fresh D1), sync will no-op. Verify import includes allowlist rows. | S2/S4 | `SELECT COUNT(*) FROM repo_allowlist` after import; seed manually if empty |
| 9 | **Milestone parse function**: `parse_milestone()` in `src/roxabi_live/dep_graph/v6/parse.py` must be ported to TypeScript. Logic not reviewed here — needs separate read before S6. | S6 | Read `parse.py` before implementing `worker/src/sync/parse.ts` |
