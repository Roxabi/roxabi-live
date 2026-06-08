# S8 — Cron trigger + observability (runbook)

Issue [#100](https://github.com/Roxabi/roxabi-live/issues/100) · epic [#92](https://github.com/Roxabi/roxabi-live/issues/92).

The **code** for S8 shipped in S4 (#96): the hourly Cron trigger, the `scheduled()`
handler, and the auth-halt → `NOTIFY_URL` alert all exist. This slice adds the
**observability config** and the **operational steps** that can't live in the repo, plus
two code hardening changes (typed `Env.NOTIFY_URL`, halt-alert test).

This was the **hard go/no-go gate** before S9 cutover (#101): do **not** decommission M₁
until a **persistent prod audit trail** exists, because M₁'s local logs vanish with it.

> **Update (2026-06-08):** S9 cutover is **DONE**. The gate passed — prod R2 audit confirmed
> before M₁ decommission. See `docs/s9-cutover.md` for the completed cutover record.

> **Update (#120):** Logpush was abandoned — it requires the Workers **Paid** plan and
> this account is on **Free**. The persistent audit is instead written by the Worker
> itself: `runSync` puts a per-run JSON summary to R2 bucket `roxabi-live-logs`
> (`runs/<date>/<ts>.json`). The Logpush ops below are kept for reference only; the
> live gate is now "a recent prod `runs/…json` exists in R2" — see `docs/s9-cutover.md`.

---

## What's in the repo (this PR)

| Change | File | Effect |
|---|---|---|
| Workers Logs enabled | `wrangler.toml` `[observability]` + `[env.staging.observability]` | emits invocation logs for Logpush to ship |
| Typed halt-alert binding | `worker/src/types.ts` (`Env.NOTIFY_URL?`) | replaces inline `(env as …)` cast |
| Halt-alert tests | `worker/src/sync/sync.test.ts` | POST fires with `sync_halted` body / no-op when unset |

`[observability] enabled = true` must be live (deployed) **before** a Logpush job can
select the Workers Logs dataset.

---

## Ops steps (Cloudflare side — run once per environment)

Account: `b5e90be971920ce406f7b679c4f1cd33` (mickael@bouly.io). `CLOUDFLARE_API_TOKEN` is
already in the shell env (see provisioning memory). Run from repo root.

### 1. Create the R2 audit bucket

```bash
wrangler r2 bucket create roxabi-live-logs
# (optional) staging isolation:
# wrangler r2 bucket create roxabi-live-logs-staging
```

### 2. Create the Logpush job → R2 (Workers Logs dataset)

Logpush has **no `wrangler` subcommand** — use the API. `workers_trace_events` is the
dataset backing Workers Logs.

```bash
ACCOUNT=b5e90be971920ce406f7b679c4f1cd33
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/logpush/jobs" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "roxabi-live-logs",
    "dataset": "workers_trace_events",
    "destination_conf": "r2://roxabi-live-logs/{DATE}?account-id='"${ACCOUNT}"'&access-key-id=<R2_ACCESS_KEY_ID>&secret-access-key=<R2_SECRET>",
    "enabled": true,
    "output_options": {
      "field_names": ["EventTimestampMs","Outcome","ScriptName","Logs","Exceptions"],
      "timestamp_format": "rfc3339"
    }
  }'
```

R2 S3 credentials: **R2 → Manage R2 API Tokens** in the dashboard (Object Read & Write,
scoped to `roxabi-live-logs`). The token used here needs the **Logpush** account permission.

Verify the job:

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/logpush/jobs" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result[] | {name,dataset,enabled,last_complete,last_error}'
```

### 3. Set the halt-alert secret

`NOTIFY_URL` = an ntfy topic or webhook that reaches you (the breaker POSTs
`{"event":"sync_halted","ts":…}` on 2 consecutive auth failures).

```bash
# prod
printf %s 'https://ntfy.sh/<your-topic>' | wrangler secret put NOTIFY_URL
# staging
printf %s 'https://ntfy.sh/<your-topic>' | wrangler secret put NOTIFY_URL --env staging
```

Unset = alerts disabled (the code no-ops; the breaker still halts the sync).

---

## Acceptance verification (Accept criteria, #100)

1. **≥1 successful Cron execution in prod.** After deploy, wait for the top of an hour, then:

   ```bash
   # CF dashboard → Workers & Pages → roxabi-live → Cron → invocation log shows success
   # OR via D1 (watermark advanced within the last ~65 min):
   wrangler d1 execute roxabi-live-production --remote \
     --command "SELECT key, value, datetime(updated_at) FROM sync_control WHERE key IN ('halted','auth_failures'); SELECT MAX(last_synced_at) AS watermark FROM sync_state;"
   ```

2. **R2 receives logs.** Logpush flushes every ~5 min / 100k lines:

   ```bash
   wrangler r2 object get roxabi-live-logs --prefix "$(date -u +%Y%m%d)" 2>/dev/null || \
   curl -sS "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/logpush/jobs" \
     -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result[] | select(.name=="roxabi-live-logs") | {last_complete,last_error}'
   ```

3. **`/api/version` timestamp ≤ 65 min old** after one prod hour:

   ```bash
   curl -sS https://<prod-host>/api/version | jq '.'
   ```

All three green → S8 done → S9 (#101) cutover unblocked.

---

## Halt-alert manual smoke test (optional)

Force the breaker on staging without a real GitHub outage:

```bash
wrangler d1 execute roxabi-live-staging --remote \
  --command "UPDATE sync_control SET value='1' WHERE key='auth_failures'"
# rotate GITHUB_TOKEN to an invalid value, trigger /admin/sync, confirm the NOTIFY_URL POST,
# then restore the token and: UPDATE sync_control SET value='0' WHERE key IN ('auth_failures','halted')
```
