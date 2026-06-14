# S7 — NOT-NULL migration + CF Access narrowing (runbook)

Issue [#150](https://github.com/Roxabi/roxabi-live/issues/150) · epic [#141](https://github.com/Roxabi/roxabi-live/issues/141).

## Status: NOT YET EXECUTED

This is the operator procedure for the S7 go. The repo PR + a green staging deploy are what ships now; the cutover below is operator-gated.

---

S7 flips CF Access from "gate the whole app" to "gate `/admin/*` only". Until this
slice, every user other than `mickael@bouly.io` hits the Access Email-OTP wall before
reaching any Worker route. App-level sessions (OAuth + session cookies, built in
S2–S6, #144–#149) are the real auth gate for the public app — but they were unreachable
behind the edge wall. S7 narrows Access to the admin surface only, so the Worker's own
`requireSession` takes over. This is the slice that *actually opens the door to
multi-tenancy*.

---

## What ships in this PR

| File | Change |
|---|---|
| `worker/migrations/0008_tenant_not_null.sql` | M-b: `sync_control.value TEXT` → `TEXT NOT NULL`; rename-swap (data survives every crash point; self-guarding INSERT) |
| `docs/s7-access-cutover.md` | This runbook |
| `CLAUDE.md` | Access-line updated to reflect S7 end-state |
| `frontend/.assetsignore` | Excludes `*.test.js`, `vitest.config.js`, `package.json`, `package-lock.json`, `node_modules/` from ASSETS bundle — confirm uploaded-asset count dropped / those URLs 404 in staging deploy log |

CI auto-applies `0008` on merge: `wrangler d1 migrations apply DB --env staging --remote`
(→ staging D1) and `wrangler d1 migrations apply DB --remote` on promote to main (→ prod
D1). See `.github/workflows/ci.yml` deploy job.

---

## Go/No-Go checklist — **STOP if any item is unchecked**

```
[ ] 0008 merged to staging; CI migrations apply step green (staging D1)
[ ] staging preflight COUNT NULL = 0  (Phase 1 below)
[ ] staging smoke: /api/graph unauth → 401; /api/version → 200  (Phase 2 below)
[ ] prod preflight COUNT NULL = 0  (Phase 1, prod variant — run BEFORE promote)
[ ] promote staging → main; CI applies 0008 to prod D1 green
[ ] CF Access: new /admin app added and /admin/sync OTP-challenged  (Phase 3, step 1–2)
[ ] staging smoke confirmed green before removing App 1  (Phase 3, step 3)
[ ] ADMIN_TOKEN verified set (wrangler secret list --env … shows it) OR edge-Access-only mode for /admin/* intentionally accepted  (Phase 3, before step 4)
[ ] CF Access: App 1 (catch-all) removed  (Phase 3, step 4)
[ ] post-flip verification curls pass  (Phase 3, step 5)
[ ] SC2 browser-flow: private/incognito → live.roxabi.dev → frontend auth-gate (not raw 401)  (Phase 3, step 5)
[ ] rollback confirmed actionable  (Rollback section)
```

---

## Phase 1 — M-b NOT-NULL preflight + apply

Run the preflight gate **before merge for staging** and **before promote for prod**.

> **Account note:** `CLOUDFLARE_ACCOUNT_ID` must be exported. The token sees two accounts and `d1 execute --remote` 403s without an explicit account ID.

```bash
export CLOUDFLARE_ACCOUNT_ID=b5e90be971920ce406f7b679c4f1cd33
cd worker

# staging:
npx wrangler d1 execute DB --env staging --remote --config ../wrangler.toml \
  --command "SELECT COUNT(*) AS null_values FROM sync_control WHERE value IS NULL;"
# expect: null_values = 0

# prod (run BEFORE promote to main):
npx wrangler d1 execute DB --remote --config ../wrangler.toml \
  --command "SELECT COUNT(*) AS null_values FROM sync_control WHERE value IS NULL;"
# expect: null_values = 0
```

**Self-guard property:** `0008`'s `INSERT … SELECT` into the new `value TEXT NOT NULL`
column throws *before any rename* if a stray NULL exists. A bad state fails the CI
migrate step loudly (red CI, `sync_control` still intact) rather than silently corrupting
data. Locally validated: sqlite3 + `wrangler d1 migrations apply --local`, all 8
migrations apply, 6 seeded rows preserved, NULL-insert correctly rejected.

If COUNT > 0: do **not** proceed. Investigate which write path produced a NULL in
`sync_control.value` (all known write paths bind a non-NULL string — see plan #150).

### Migration re-apply recovery (theoretical)

D1 wraps each migration file in an implicit transaction — a mid-file crash rolls back the
whole migration. Two possible partial-crash states and their recovery commands:

```bash
export CLOUDFLARE_ACCOUNT_ID=b5e90be971920ce406f7b679c4f1cd33
cd worker
# staging (drop --env staging for prod):
```

- **`no such table: sync_control`** (crash after first rename, before second):
  ```bash
  npx wrangler d1 execute DB --env staging --remote --config ../wrangler.toml \
    --command "ALTER TABLE sync_control_new RENAME TO sync_control; DROP TABLE IF EXISTS sync_control_old;"
  ```
- **`table sync_control_old already exists`** (crash before first rename completed):
  ```bash
  npx wrangler d1 execute DB --env staging --remote --config ../wrangler.toml \
    --command "DROP TABLE sync_control_old;"
  # then re-apply migration 0008
  ```

In practice the implicit transaction makes these states unreachable in normal operation;
the recovery block is here for completeness.

---

## Phase 2 — Staging smoke gate

Staging (`roxabi-live-staging.mickael-b5e.workers.dev`) has no CF Access in front —
requests go directly to the Worker. This isolates the Worker's own `requireSession` gate,
proving the exact behavior prod must show once the edge Access wall is removed.

```bash
# unauthenticated graph request — Worker requireSession must reject:
curl -s -o /dev/null -w '%{http_code}\n' \
  https://roxabi-live-staging.mickael-b5e.workers.dev/api/graph
# expect: 401

# version is public — no session required:
curl -s -o /dev/null -w '%{http_code}\n' \
  https://roxabi-live-staging.mickael-b5e.workers.dev/api/version
# expect: 200
```

A `200` on `/api/graph` without a session cookie is a **STOP** — do not remove App 1
until this is resolved.

**Recommended (not blocking):** confirm a valid session returns 200. Obtain a session
cookie via interactive `/login` → OAuth on the staging Worker URL, then (the cookie name
is `__Host-session` — copy it exactly; a wrong name false-fails as 401):

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -b '__Host-session=<cookie-value>' \
  https://roxabi-live-staging.mickael-b5e.workers.dev/api/graph
# expect: 200
```

If interactive login is not convenient at go-time, skip this curl and log it; the
401-unauth check above is the hard gate.

---

## Phase 3 — CF Access narrowing (prod, dashboard)

Account `b5e90be971920ce406f7b679c4f1cd33` (mickael@bouly.io). **Order is mandatory** —
add the specific `/admin` app before removing the catch-all (mirror S9's "App 2 before
App 1"). Never leave `/admin` unprotected between steps.

**Before starting:** in the CF Access dashboard, open App 1 (catch-all) settings and
record its current session duration. The default is **24 h** (per `docs/cloudflared-setup.md`
Step A.4) — confirm and write down the live value. You will need it for rollback.

### Step 1 — Add "Roxabi Live Admin" app

Zero Trust → Access → Applications → Add → **Self-hosted**.

- Name: `Roxabi Live Admin`
- Domain: `live.roxabi.dev`, path: `/admin`
  (CF Access uses prefix match — `/admin` covers `/admin/*`; do NOT enter `/admin*` or a wildcard)
- Policy: **Allow**, include emails `mickael@bouly.io`, session duration: **24 h** (confirm
  matches the value recorded above)
- Auth method: One-time PIN

Clone all other settings from the existing App 1 policy. App 2 (`/webhook` Bypass)
remains untouched throughout.

### Step 2 — Verify the new app gates `/admin`

App 1 still guards everything else at this point — nothing is exposed yet. Between Step 1
and Step 4, BOTH Access apps cover `/admin`; CF Access resolves the most-specific path
match, so the OTP challenge below is answered by the new `/admin`-scoped app — not App 1.
Step 4 then removes App 1 (the legacy catch-all).

```bash
curl -sS -D - -o /dev/null https://live.roxabi.dev/admin/sync \
  | grep -iE 'HTTP/|^location'
# expect: redirect to *.cloudflareaccess.com  (OTP challenge from new /admin app)
```

### Step 3 — Confirm staging smoke gate is green

The Phase 2 check (`401` on `/api/graph` unauth) must be confirmed before proceeding.
Do not remove App 1 until the Worker's `requireSession` is proven to hold on its own.

### Step 4 — Remove App 1 (catch-all)

Access → Applications → find the all-paths OTP app (`live.roxabi.dev`, no path) →
Delete. Leave App 2 (`/webhook` Bypass) and the new `/admin` app.

After removal:
- `/admin/*` → OTP (new app)
- `/webhook/*` → Bypass (App 2)
- Everything else → edge-open → Worker `requireSession` (401 unauth / 200 with cookie)

### Step 5 — Post-flip verification

```bash
# public-app path: gated by Worker, NOT edge — expect 401, no Access redirect:
curl -sS -D - -o /dev/null https://live.roxabi.dev/api/graph \
  | grep -iE 'HTTP/|^location|cf-access'
# expect: HTTP 401  |  no Location: *.cloudflareaccess.com  |  no cf-access-* headers

# issues endpoint: also Worker-gated — expect 401:
curl -sS -D - -o /dev/null https://live.roxabi.dev/api/issues \
  | grep -iE 'HTTP/|^location|cf-access'
# expect: HTTP 401  |  no Location: *.cloudflareaccess.com  |  no cf-access-* headers

# admin path: still OTP:
curl -sS -D - -o /dev/null https://live.roxabi.dev/admin/sync \
  | grep -iE 'HTTP/|^location'
# expect: redirect to *.cloudflareaccess.com

# webhook path: still Bypass (Worker response, no challenge):
curl -sS -D - -o /dev/null https://live.roxabi.dev/webhook/github \
  | grep -iE 'HTTP/|^location|cf-access'
# expect: Worker response (4xx — missing HMAC body), no Access redirect, no cf-access headers
```

**SC2 browser-flow verification (manual):** open a private/incognito window →
navigate to `https://live.roxabi.dev` without any session cookie → expect the frontend
auth-gate (login/landing view from `frontend/auth.js`, #149), NOT a raw JSON `401` or
blank page. A raw 401 here means the Worker's `requireSession` is firing on `/` or
static assets — stop and investigate before declaring the flip done.

---

## Edge-exposed-after-flip routes (accepted)

Once App 1 is removed these routes are reachable at the edge without an OTP challenge.
Each is intentionally exposed:

| Route | Why safe |
|---|---|
| `/` + static assets | Frontend auth-gate (`frontend/auth.js`, #149) redirects unauthenticated users to login before any data loads |
| `/api/version` | Returns `data_version` timestamp only — no user or issue data |
| `/health` | Returns aggregate issue `COUNT(*)` only — no tenant or user data |
| `/login`, `/oauth/callback` | Auth-flow entry points — required to be reachable |
| `POST /logout` | Session invalidation — ungated by design (null-safe + idempotent, `SameSite=Strict` blocks cross-site submission); clears cookie, exposes no data |

Sensitive reads keep `requireSession` (→ 401 unauth):

`/api/graph`, `/api/issues`, `/api/issues/:key`, `/api/me`, `/api/active-tenant`

`/admin/*` keeps **both** the new edge OTP app **and** the `ADMIN_TOKEN` Bearer gate
(#123, defense-in-depth).

---

## Rollback (re-enable Access on the full app)

To restore the pre-S7 state (whole app behind Access):

1. Zero Trust → Access → Applications → Add → **Self-hosted**.
   - Domain: `live.roxabi.dev`, path: empty (all paths)
   - Policy: **Allow**, include emails `mickael@bouly.io`, session duration: the value
     you recorded before starting Phase 3 (default **24 h** — use the live value you
     wrote down, not the default)
2. Verify the catch-all OTP app gates `/api/graph`:
   ```bash
   curl -sS -D - -o /dev/null https://live.roxabi.dev/api/graph \
     | grep -iE 'HTTP/|^location'
   # expect: redirect to *.cloudflareaccess.com
   ```
3. Keep App 2 (`/webhook` Bypass) and the new `/admin` app — do not remove them.

The public app is immediately behind Access again. The `0008` migration is independent of
the Access state and is **not rolled back** — it is forward-safe (no code path writes NULL
to `sync_control.value`).

---

## Honesty note

- Operator retains full read access to user data at rest in D1 (Phase 1 of epic #141; no
  encryption layer yet — carried as a known item).
- After the flip, `/health` and `/api/version` are publicly reachable at the edge. Both
  return non-sensitive aggregate data only (issue count, data-version timestamp).
