# S9 — Cutover to live.roxabi.dev + M₁ decommission (runbook)

Issue [#101](https://github.com/Roxabi/roxabi-live/issues/101) · epic [#92](https://github.com/Roxabi/roxabi-live/issues/92).

Final slice of the Cloudflare serverless migration. Goes live on `live.roxabi.dev`
and retires M₁. **No bridge** — the Tailscale Funnel
(`https://roxabituwer.goose-logarithm.ts.net`) served as the interim public ingress
during the rewrite; `live.roxabi.dev` is created once, here, at cutover.

This is a **one-way door**: Phase 5 stops M₁ and retires the Funnel. Do not start
Phase 4/5 until every go/no-go item is green.

---

## What's in the repo (this PR)

| Change | File | Effect |
|---|---|---|
| Prod custom domain | `wrangler.toml` top-level `routes` (`custom_domain = true`) | next **production** deploy provisions DNS + TLS for `live.roxabi.dev` → this Worker |

`routes` is an **inheritable** wrangler key (unlike the *bindings* `[[d1_databases]]` /
`[[r2_buckets]]`, which are not). So `[env.staging]` must explicitly set `routes = []`
to break the inheritance — otherwise a `--env staging` deploy would inherit this entry
and bind `live.roxabi.dev` to the **staging** Worker. With that override in place,
merging this PR to **staging** is inert for the domain; the route activates only on a
deliberate prod deploy (Phase 4). Ref: cloudflare/workers-sdk#13925.

> ⚠️ **Security ordering gate.** The first production deploy after this merge creates
> `live.roxabi.dev`. CF Access **App 1 (Email OTP)** must exist *before* that deploy,
> or the dashboard is briefly reachable unauthenticated. Phase 4 enforces this order.

---

## Current state (audited 2026-06-08)

Phases 1–3 of the epic runbook are already done — S9 is the cutover + decommission only.

| Item | State | Evidence |
|---|---|---|
| Prod D1 `roxabi-live-production` | ✅ created + populated (~2647 issues) | `wrangler d1 execute roxabi-live-production --command "SELECT COUNT(*)…" --remote` |
| Prod Worker `roxabi-live` | ✅ deployed (2026-06-08 09:24), secrets set | `wrangler deployments list` |
| Staging Worker | ✅ healthy (200 on `/health`, `/api/version`, `/api/graph`) | `curl …roxabi-live-staging.mickael-b5e.workers.dev` |
| M₁ baseline node count | **2658** | `curl …roxabituwer.goose-logarithm.ts.net/api/graph` |
| Prod `*.workers.dev` URL | ⚠️ returns CF `error 1042` (workers.dev route disabled) | `curl …roxabi-live.mickael-b5e.workers.dev/api/version` → 404 / 1042 |

**On the `1042`:** the prod Worker does not serve over `*.workers.dev`. This is the
desired end state (prod is reachable only via `live.roxabi.dev` behind CF Access), but
it means the prod smoke test below **cannot** use the workers.dev URL. Resolve one of:
- temporarily enable `workers.dev` for a pre-cutover smoke, then disable; **or**
- smoke directly after the custom domain is bound, via an Access **service token** (so
  the API call isn't bounced to the OTP login); **or**
- rely on the staging smoke (identical code) + a `wrangler tail` capture of a prod cron
  run to confirm the prod Worker executes and writes its audit object.

---

## Go/No-Go checklist — **STOP if any item is unchecked**

```
[ ] Worker /api/graph node count ≥ 2658 (M₁ baseline)
[ ] Worker /api/version returns an ISO timestamp within the last 2h
[ ] Worker /health returns 200
[ ] Prod cron fired ≥ once: D1 `SELECT MAX(last_synced_at) FROM sync_state` within last 2h
[ ] Webhook HMAC verify passes: test delivery → endpoint returns 2xx
[ ] PERSISTENT AUDIT (supersedes the old "Logpush configured" item):
      #120 Worker self-write audit confirmed in PROD —
      a recent runs/<date>/<ts>.json exists in R2 bucket `roxabi-live-logs`,
      written by a PROD tick. ⚠️ staging shares this bucket (same bucket_name),
      so do NOT accept a bare "an object exists" — confirm the writer was prod:
      capture the key via `wrangler tail roxabi-live` during a prod cron run, or
      match the object's `watermark` to prod D1. (Logpush was abandoned — it
      needs Workers Paid; account is Free. See docs/s8-cron-observability.md + #120.)
[ ] CF Access OTP tested: mickael@bouly.io receives a code, dashboard loads
[ ] CF Access Bypass on /webhook/* confirmed: no OTP prompt on the webhook URL
[ ] Admin /admin/sync tested (manual trigger works behind OTP / service token).
      NB: edge Access is the ONLY gate today — Worker-side JWT verification is
      deferred (#123, spec #92 open-Q7). Close #123 before Phase 5 decommission.
[ ] sync_control.halted = '0' (not halted) on prod
```

Verify the audit gate (prod):

```bash
# NOTE: staging writes to this same bucket — list shows both. To attribute a
# write to PROD, tail the prod Worker while a cron tick (or /admin/sync) runs:
wrangler tail roxabi-live --format pretty   # watch for: [sync] audit written → runs/…
# most recent audit object overall (staging+prod mixed; <2h old expected):
wrangler r2 object list roxabi-live-logs --remote --prefix "runs/" 2>/dev/null | tail -5
# inspect one (its `watermark` should match prod D1's MAX(last_synced_at)):
wrangler r2 object get "roxabi-live-logs/runs/<date>/<ts>.json" --remote --pipe | jq .
```

---

## Phase 4 — Cutover (CF Access → custom domain → webhook)

Account `b5e90be971920ce406f7b679c4f1cd33` (mickael@bouly.io). **Order is mandatory.**

### 4.1 — CF Access apps (Zero Trust dashboard) — BEFORE any prod deploy

1. **Add identity provider:** Zero Trust → Settings → Authentication → add **One-time PIN**
   (Email OTP — free, no extra IdP).
2. **App 2 first (more specific path) — webhook bypass:**
   Access → Applications → Add → **Self-hosted**.
   - Domain: `live.roxabi.dev`, path: `/webhook` (covers `/webhook/*`).
   - Policy: **Bypass**, include **Everyone**.
   - Rationale: GitHub webhook deliveries must not hit an OTP wall; the Worker's HMAC
     verification (`GITHUB_WEBHOOK_SECRET`) is the sole gate on that path.
3. **App 1 — dashboard OTP:**
   Access → Applications → Add → **Self-hosted**.
   - Domain: `live.roxabi.dev` (all paths).
   - Policy: **Allow**, include emails `mickael@bouly.io`, session via One-time PIN.
   - Confirm App 2's `/webhook` rule takes precedence over App 1's catch-all.

### 4.2 — Activate the custom domain (production deploy)

The `routes` entry in `wrangler.toml` provisions `live.roxabi.dev` on the next prod
deploy. Prefer promoting through the pipeline:

```bash
# Preferred: /promote (staging → main) → CI runs `wrangler deploy` (prod) → binds route
# Manual equivalent (from repo root):
cd worker && npx wrangler deploy --config ../wrangler.toml   # NO --env => production
```

```bash
# DNS + cert propagate (~30s for CF-managed zones). Must return a CF-Ray header:
curl -I https://live.roxabi.dev/api/version
```

A browser hitting `live.roxabi.dev` should now be redirected to the Email-OTP login.

**Verify Access policy precedence (App 2 Bypass must win over App 1 OTP) — do this
BEFORE repointing the webhook in 4.3:**

```bash
# Webhook path = BYPASS (App 2): expect a Worker response (2xx/4xx), NOT a redirect
# to the Access login (no Location → *.cloudflareaccess.com, no cf-access-* headers):
curl -sS -D - -o /dev/null https://live.roxabi.dev/webhook/github | grep -iE 'HTTP/|^location|cf-access'
# Dashboard path = OTP (App 1): expect a redirect to the Access login:
curl -sS -D - -o /dev/null https://live.roxabi.dev/api/graph | grep -iE 'HTTP/|^location'
```

If `/webhook/github` bounces to the OTP login, App 2's precedence is wrong — fix the app
order / path scope before 4.3 (otherwise GitHub deliveries will be challenged and fail).
Path traversal (`/webhook/../admin`) cannot leak the Bypass: CF normalizes the path at
the edge before policy eval, so it matches `/admin` (App 1 OTP), not App 2.

### 4.3 — Repoint the GitHub org webhook

GitHub → Org **Roxabi** → Settings → Webhooks → the roxabi-live hook:
- Payload URL → `https://live.roxabi.dev/webhook/github`
- Secret → the **production** `GITHUB_WEBHOOK_SECRET` value (must match the prod Worker
  secret set via `wrangler secret put GITHUB_WEBHOOK_SECRET`).
- Redeliver the last event → expect HTTP 2xx (HMAC OK, no OTP challenge).

---

## Phase 5 — M₁ decommission (one-way door)

Only after `live.roxabi.dev` has served stably (webhook + a cron cycle) for a sane soak.

```bash
# On M₁ (roxabituwer):
systemctl --user stop live.service
systemctl --user disable live.service

# Archive the local corpus (no longer the source of truth — D1 is). The glob
# also grabs any -wal/-shm sidecars in case the last shutdown wasn't clean:
cp ~/.roxabi/corpus.db ~/.roxabi/corpus.db.bak.$(date +%Y%m%d)
cp ~/.roxabi/corpus.db-wal ~/.roxabi/corpus.db-wal.bak.$(date +%Y%m%d) 2>/dev/null || true
cp ~/.roxabi/corpus.db-shm ~/.roxabi/corpus.db-shm.bak.$(date +%Y%m%d) 2>/dev/null || true

# Retire the Tailscale Funnel that fronted live.service:
tailscale funnel --https=443 off    # (or `tailscale serve reset` if it was the only serve)
```

Verify everything routes through the CF Worker:

```bash
curl -I https://live.roxabi.dev/api/version | grep -i cf-ray
curl -s https://live.roxabi.dev/api/graph | jq '.nodes | length'   # ≥ 2658
```

Post-decommission, update `~/projects/CLAUDE.md` (drop M₁ `ops-cockpit` role / native
`live.service` line) and the `roxabi-live` row.

---

## Rollback (any time before Phase 5 completes)

```bash
# Re-enable M₁ and reach it via the still-registered Funnel:
systemctl --user start live.service
#   → https://roxabituwer.goose-logarithm.ts.net

# Remove the Worker custom domain:
#   CF dashboard: Workers & Pages → roxabi-live → Domains & Routes → remove live.roxabi.dev
#   (or revert the wrangler.toml `routes` block and redeploy prod)
#   The [env.staging] `routes = []` override is inert during rollback — leave it.
```

After Phase 5 (M₁ stopped, Funnel retired): rollback means redeploy-from-git + a fresh
D1 import. Target RTO ~30 min.

---

## Acceptance (issue #101)

- [ ] `https://live.roxabi.dev/api/graph` returns a `CF-Ray` header
- [ ] node count stable (≥ 2658)
- [ ] M₁ `live.service` stopped + disabled
- [ ] Tailscale Funnel retired
