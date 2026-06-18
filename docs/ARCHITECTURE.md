# Architecture — Roxabi Live

Roxabi Live is a serverless operations cockpit that syncs GitHub issues and their dependency graph from a GitHub App installation into a Cloudflare D1 database, then serves the graph as a filterable web UI. The entire stack runs on Cloudflare: a single Worker handles HTTP via Hono, a Cron Trigger drives a daily full reconcile, static frontend assets are served through the Worker's ASSETS binding, and R2 stores per-run audit logs. There is no persistent server, no Python runtime, and no local database in production.

---

## Serverless topology

```
                       Cloudflare edge
 ┌─────────────────────────────────────────────────────────────┐
 │                                                             │
 │  CF Access (Email-OTP)          ┌─────────────────────┐    │
 │  gates /admin/*                 │   Cloudflare Worker  │    │
 │  Bypass on /webhook/*           │   (roxabi-live)      │    │
 │                                 │                      │    │
 │  Browser ──────────────────────►│  fetch handler       │    │
 │  GitHub webhook ───────────────►│    Hono router       │    │
 │  Cron (0 0 * * *) ────────────►│  scheduled handler   │    │
 │                                 └──────┬───────────────┘    │
 │                                        │                    │
 │              ┌─────────────────────────┼─────────────┐      │
 │              │                         │             │      │
 │              ▼                         ▼             ▼      │
 │         D1 (DB)              R2 (LOGS)        ASSETS        │
 │   roxabi-live-production    per-run audit    frontend/       │
 │   [YOUR_D1_ID_PROD]         JSON files       HTML/JS/CSS     │
 └─────────────────────────────────────────────────────────────┘
```

Worker entry: `worker/src/index.ts` — exports `fetch` (HTTP) and `scheduled` (Cron) handlers. Routing via Hono in `worker/src/router.ts`.

---

## Route table

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/version` | public | Build/version info |
| `GET` | `/health` | public | DB reachability check + issue count |
| `GET` | `/login` | public | Start GitHub App OAuth flow |
| `GET` | `/oauth/callback` | public (validates D1 `oauth_state`) | Exchange code, create session, set cookie |
| `POST` | `/logout` | public (null-safe) | Clear `__Host-session` cookie |
| `GET` | `/api/me` | session | Current authenticated user |
| `POST` | `/api/active-tenant` | session | Org-picker: set active tenant (>1 installation) |
| `GET` | `/api/issues` | session | List issues (params: `repo`, `state`, `label`, `limit`, `offset`) |
| `GET` | `/api/issues/*` | session | Single issue by key, e.g. `MyOrg/myrepo#42` |
| `GET` | `/api/graph` | session | Full dep-graph JSON (nodes + edges), scoped to visible repos |
| `POST` | `/webhook/github` | HMAC-SHA256 (`GITHUB_WEBHOOK_SECRET`); CF Access Bypass | GitHub org webhook receiver |
| `POST` | `/admin/sync` | ADMIN_TOKEN Bearer + CF Access Email-OTP | Out-of-band sync trigger |
| `*` | `/*` | public (ASSETS fallback) | Static frontend from `frontend/` |

Session = `requireSession` middleware: reads `__Host-session` cookie → validates SHA-256 hash against D1 `sessions` table → attaches session context or returns 401.

---

## Request flow

```
Browser GET /api/graph
  │
  ├─ No __Host-session cookie ──► 401 (frontend redirects to /login)
  │
  ├─ Cookie present
  │     │
  │     ├─ Lookup token_hash in D1 sessions → expired/missing ──► 401
  │     │
  │     └─ Valid session (user_id, tenant_id)
  │           │
  │           ├─ resolveVisibleRepos(tenant_id, user_id)
  │           │     └─ tenant_repo_access JOIN repos WHERE NOT is_private
  │           │        UNION private repos WHERE user has cached permission
  │           │
  │           └─ SELECT issues + edges WHERE repo IN visible_repos
  │                 └─ Return graph JSON
  │
GET /webhook/github (POST)
  │
  ├─ Verify X-Hub-Signature-256 (Web Crypto, GITHUB_WEBHOOK_SECRET)
  ├─ Dispatch: issues / deps / sub_issues event handlers
  └─ D1 upsert via worker/src/webhook/mutations.ts
```

---

## Multi-tenant auth model

### GitHub App OAuth

1. `GET /login` — generates CSRF state, inserts into D1 `oauth_state` (10-minute TTL), redirects to GitHub authorize URL using `GITHUB_APP_CLIENT_ID`.
2. `GET /oauth/callback` — consumes state (DELETE RETURNING, single-use), exchanges code for GitHub user token via `GITHUB_APP_CLIENT_SECRET`, upserts `users` + `tenants` + `user_installations` rows, creates session.
3. On no installations found: redirects to `https://github.com/apps/<YOUR_APP_SLUG>/installations/new`.

> **Fork:** Replace `<YOUR_APP_SLUG>` with your GitHub App's slug. The install URL is constructed from the App slug set during App creation.

### Session cookie

| Attribute | Value |
|-----------|-------|
| Name | `__Host-session` (constant `SESSION_COOKIE`) |
| TTL | 28 800 s (8 h) |
| Flags | `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` |
| Storage | SHA-256 hash stored in D1 `sessions`; raw token never persisted |

`__Host-` prefix mandates `Secure` + `Path=/` + no `Domain` attribute — prevents subdomain token theft.

Revocation: delete row from `sessions` on logout or tenant suspension.

### Suspended-tenant guard

`tenants.suspended = 1` → `requireSession` returns 401 and clears cookie. Sync halts for that installation.

### Authorization: tenant-scoped reads

All `/api/*` reads are scoped through `resolveVisibleRepos`:

- Public repos: `tenant_repo_access JOIN repos WHERE NOT is_private`
- Private repos: per-user permission cache in D1 (populated from GitHub App install-token API calls)
- `repos.is_private` defaults to `1` (fail-closed, migration 0007) — a repo is treated as private until a sync run confirms otherwise

**Data tables (`issues`, `edges`, `repos`) carry no `tenant_id` column.** `issues.key` is globally unique (`MyOrg/myrepo#42`). Authorization is enforced at query time via the `tenant_repo_access` JOIN — not at rest on data rows (repo-canonical decision, #141).

### Webhook HMAC

`POST /webhook/github` verifies `X-Hub-Signature-256` using Web Crypto `crypto.subtle` (no `nodejs_compat` flag needed). Secret: `GITHUB_WEBHOOK_SECRET` (org-level webhook secret — **not** `GITHUB_APP_WEBHOOK_SECRET`, which exists in the `Env` interface but is not read on the request path). CF Access Bypass policy applies at the edge so GitHub can reach this endpoint.

### Admin endpoint

`POST /admin/sync` is protected by two independent layers:

1. CF Access Email-OTP at the Cloudflare edge
2. `Authorization: Bearer <ADMIN_TOKEN>` check in `worker/src/api/admin.ts`

`ADMIN_TOKEN` unset = Worker-level gate disabled; CF Access alone guards.

---

## Sync architecture

### Install-token fan-out (PAT-free)

`GITHUB_TOKEN` (PAT) was retired in Phase 1 (#160, 2026-06-13). All GitHub API calls now use per-installation tokens:

1. Worker signs an App-JWT using `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (PKCS#8 DER, base64-encoded).
2. Exchanges JWT for an installation access token via GitHub Apps REST API.
3. Token cached encrypted (AES-GCM, `INSTALL_TOKEN_KEY` DEK) in D1 `install_tokens` — avoids per-request JWT generation.
4. GraphQL queries run per installation using the cached token.

Auth circuit breaker in `sync_control`: `auth_failures >= 2` sets `halted = 1`, sync stops, optional `NOTIFY_URL` alert fires.

### GraphQL fields fetched

`subIssues`, `parent`, `blockedBy`, `blocking` — used to derive both `parent` and `blocks` edges.

### Edge algorithm

| Relationship | GraphQL field | Edge direction | `kind` |
|--------------|---------------|----------------|--------|
| Parent → child | `subIssues` | `src=parent, dst=child` | `parent` |
| Child → parent | `parent` | `src=parent, dst=child` | `parent` |
| Blocks | `blockedBy`/`blocking` | `src=blocker, dst=blocked` | `blocks` |

Edge semantics:

- `parent`: `src` is the parent issue, `dst` is a sub-issue. Parent must complete before children can proceed.
- `blocks`: `src` blocks `dst`. `src` open → `dst` is blocked; `src` closed → `dst` is ready.

Per-issue upsert deletes only edges of the same `kind` before re-inserting — preserves the other kind.

Frontend status computation (`frontend/state.js`):

```js
if (node.state === 'closed') return 'done';
const openBlocker = blockers.some(e => nodesByKey.get(e.src)?.state === 'open');
return openBlocker ? 'blocked' : 'ready';
```

### Slot rotation (subrequest cap)

Cloudflare Workers have a subrequest limit per invocation. To stay within it with many repos:

- `WINDOW=20` repos processed per Cron tick
- `NUM_SLOTS=3` — repo list divided into 3 slots, each tick advances one slot
- Watermark tracked in `sync_state.slot` per repo; `sync_control.sync_started_at` seeded by migration 0006
- Known: with 34+ repos, slot 2 window `[40, 60)` may be empty → that tick is a no-op (expected, tracked #166)

> **Daily full reconcile (#80):** The Cron trigger (`0 0 * * *`) runs `since=null` — all repos, no watermark filter. This heals deps-only edge drift (e.g. `blockedBy`/`blocking` changes that arrive only via the sync path, not webhook events). The webhook still handles real-time intra-day updates.

### R2 audit

Each sync run writes a JSON audit record to R2 bucket `roxabi-live-logs` (staging: `roxabi-live-logs-staging`). Use D1 `sync_control` / `sync_state` for programmatic audit queries (R2 has no list API in wrangler v3+).

---

## Data model

### D1 tables

| Table | Purpose |
|-------|---------|
| `issues` | Issue corpus: `key`, `repo`, `number`, `payload` (JSON with title), `state`, `url`, timestamps, `milestone`, `labels` (lane/priority/size), `status`, `has_active_branch`, `is_stub` |
| `edges` | Dependency edges: `src`, `dst`, `kind` (`parent` \| `blocks`) |
| `repos` | Org repository list: `name`, `owner`, `is_archived`, `is_private`; used for tenant-filtered reads and sync fan-out |
| `sync_state` | Per-repo sync watermark (`last_synced_at`, `cursor`, `slot`); windowed rotation |
| `sync_control` | Advisory distributed lock (`sync_running`, stale after 900 s), auth circuit breaker (`auth_failures >= 2` → `halted=1`), `sync_started_at` |
| `sessions` | App-level sessions: `token_hash` (SHA-256), `user_id`, `tenant_id`, `expires_at` |
| `oauth_state` | CSRF state for OAuth flow: state token, expiry (10 min), single-use (`DELETE RETURNING`) |
| `users` | GitHub user records: `github_id`, `login`, `name`, `avatar_url`, `email` |
| `tenants` | GitHub App installations = tenants: `installation_id`, org `login`, `suspended` flag |
| `user_installations` | Many-to-many join: `user_id` ↔ `tenant_id` |
| `tenant_repo_access` | Per-tenant repo visibility: `tenant_id` + repo key; scopes `/api/*` reads |
| `install_tokens` | Encrypted GitHub App installation tokens at rest (AES-GCM) |
| `data_version` | Schema/data version marker (migration 0003) |

**Repo-canonical invariant:** `issues.key` is globally unique (`org/repo#number`). No `tenant_id` on `issues`, `edges`, or `repos`. Authorization enforced at query time via `tenant_repo_access`. `issues.payload` is the ZK seam for title (Phase 1: populated; future phases may encrypt).

### Client-side encryption (account key, #216)

Per-user **account keys** replace per-device ECDH for content encryption. Passphrase-wrapped backups live in D1 (`zk_key_backups`); ciphertext in `zk_payloads` is keyed by `(user_id, issue_key)`. Graph structure stays shared; titles are redacted API-side once any user seals an issue.

| Piece | Role |
|-------|------|
| `zk_key_backups` | Passphrase-wrapped `accountKey` per user (enrollment / multi-device unlock) |
| `zk_payloads` | Per-user AES-GCM ciphertext for issue content |
| `ZK_ACCOUNT_KEY` | Feature flag — enrollment + unlock gate when on |
| `ZK_STRUCTURE_ONLY` | Sync/webhook omit title/body from GitHub on server path |

User-facing behavior, multi-device recovery, and hybrid multi-user flows: **`docs/ZK_ENCRYPTION.md`**. Full design: `docs/zk-account-key-design.md`.

### Migrations

Applied in order at deploy time (`wrangler d1 migrations apply DB --remote`):

```
0001_initial.sql
0002_repos.sql
0003_data_version.sql
0004_tenancy_auth.sql
0005_sync_slot_seed.sql
0006_sync_started_at_seed.sql
0007_repo_access_is_private.sql
0008_tenant_not_null.sql
```

---

## Dep-graph versions

| Version | Status | Entry |
|---------|--------|-------|
| v1 | frozen (legacy CLI, decommissioned) | `dep-graph` script |
| v5 | frozen (static HTML build, decommissioned) | `dep-graph-v5` script |
| v6 | **primary** — served via CF Worker ASSETS binding | `GET /api/graph` |

---

## Key files

### Worker (active)

| File | Role |
|------|------|
| `worker/src/index.ts` | Worker entry point (`fetch` + `scheduled` handlers) |
| `worker/src/router.ts` | Request routing (Hono) |
| `worker/src/types.ts` | `Env` interface + shared types |
| `worker/src/api/issues.ts` | `GET /api/issues`, `GET /api/issues/:key` |
| `worker/src/api/graph.ts` | `GET /api/graph` |
| `worker/src/api/admin.ts` | `POST /admin/sync` (ADMIN_TOKEN-gated) |
| `worker/src/api/version.ts` | `GET /api/version` |
| `worker/src/sync/sync.ts` | Daily reconcile orchestrator + R2 audit write |
| `worker/src/sync/graphql.ts` | GitHub GraphQL client (`fetch()`) |
| `worker/src/sync/queries.ts` | GraphQL query strings |
| `worker/src/sync/parse.ts` | Issue/edge parsing |
| `worker/src/webhook/handlers.ts` | Webhook dispatch (issues/deps/sub_issues) |
| `worker/src/webhook/hmac.ts` | HMAC verification |
| `worker/src/webhook/mutations.ts` | D1 write helpers |
| `worker/migrations/` | D1 schema migrations |
| `wrangler.toml` | Worker config (bindings, Cron, routes, environments) |
| `frontend/` | Static HTML/JS/CSS served via ASSETS binding |

### Package layout

```
worker/
  src/
    index.ts          # fetch + scheduled entry
    router.ts
    types.ts
    api/              # issues, graph, admin, version
    sync/             # sync, graphql, queries, parse
    webhook/          # handlers, hmac, mutations
  migrations/
wrangler.toml         # repo root — binds both envs
frontend/             # served via ASSETS binding
```

---

## Fork / self-hosting replacements

The following values are specific to the Roxabi deployment and must be replaced when forking:

| Placeholder | Where to obtain |
|-------------|-----------------|
| `live.roxabi.dev` | Your custom domain; set in `wrangler.toml` top-level `routes` |
| `roxabi-live` / `roxabi-live-staging` | Choose your Worker names; set in `wrangler.toml` `name` + `[env.staging]` |
| `c3951107-146c-4a7d-a8a5-86d09e4570e9` (prod D1 ID) | Output of `wrangler d1 create <your-db-name>` |
| `dd96d8cd-db6b-49ed-8218-53c88773aff4` (staging D1 ID) | Output of `wrangler d1 create <your-db-name>-staging` |
| `roxabi-live-logs` / `roxabi-live-logs-staging` | Choose your R2 bucket names; create with `wrangler r2 bucket create` |
| `<YOUR_APP_SLUG>` in install redirect URL | GitHub App slug from your App's settings page |
| `GITHUB_ORG` secret | Your GitHub org slug (e.g. `MyOrg`) |
| CF Access policy (Email-OTP, mickael@bouly.io) | Create your own Access application in the Cloudflare Zero Trust dashboard scoped to `/admin/*`; add Bypass for `/webhook/*` |

> **Wrangler routes inheritance gotcha:** the top-level `routes` key in `wrangler.toml` IS inherited by named `[env.*]` blocks (unlike `d1_databases`/`r2_buckets` which are not). `[env.staging]` must explicitly set `routes = []` to prevent the staging Worker from binding your production custom domain.
