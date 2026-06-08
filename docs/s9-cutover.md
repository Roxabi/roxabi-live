# S9 — ADMIN_TOKEN auth on /admin/* (runbook)

Issue [#123](https://github.com/Roxabi/roxabi-live/issues/123) · epic [#92](https://github.com/Roxabi/roxabi-live/issues/92).

Defense-in-depth token gate for `/admin/*` Worker endpoints. Closed via **ADMIN_TOKEN
variant** (shared secret + constant-time comparison), not the full Cloudflare Access
JWKS/JWT variant — the multi-tenant rebuild will replace this auth layer entirely within
weeks, making the JWKS variant overkill for now.

**Auth model:** two-layer. The Cloudflare Access Email-OTP policy remains the outer guard
(no change). `ADMIN_TOKEN` adds a Worker-side inner guard: if set, every `/admin/*`
request must carry `Authorization: Bearer <token>`. Wrong or missing → 401, sync never
runs. Unset → gate disabled, Access is the only guard (back-compat / staging default).

---

## What's in the repo (this PR)

| Change | File | Effect |
|---|---|---|
| `ADMIN_TOKEN?` env field | `worker/src/types.ts` | typed optional secret binding |
| Auth helpers | `worker/src/api/auth.ts` | `timingSafeEqual` + `checkAdminAuth` |
| Router middleware | `worker/src/router.ts` | `app.use("/admin/*", …)` gate before handlers |
| Admin handler JSDoc | `worker/src/api/admin.ts` | references #123 auth approach |
| Auth unit tests | `worker/src/api/auth.test.ts` | 11 tests: `timingSafeEqual` + `checkAdminAuth` |
| Admin integration tests | `worker/src/api/admin.test.ts` | 9 tests: correct/wrong/missing token, unset back-compat |
| `.env.example` | `.env.example` | `ADMIN_TOKEN=` entry with wrangler instructions |

Cron (`scheduled()`), `/webhook/*`, and `/api/*` are **not gated** — only `/admin/*`.

---

## Ops steps — set the secret (run once per environment)

`ADMIN_TOKEN` is a Wrangler secret. Generate a strong random value and set it via:

```bash
# Generate a token (32 bytes → 64 hex chars)
openssl rand -hex 32

# Set on prod (default environment)
wrangler secret put ADMIN_TOKEN

# Set on staging
wrangler secret put ADMIN_TOKEN --env staging
```

`wrangler secret put` prompts for the value interactively — it is **never written to disk
or committed**. To verify the secret is registered (without revealing the value):

```bash
wrangler secret list
wrangler secret list --env staging
```

To rotate: run `wrangler secret put ADMIN_TOKEN` again. The new value takes effect on the
next request (no redeploy needed — secrets are injected at runtime).

---

## Calling `/admin/sync` with the token

```bash
# Trigger a sync on prod
curl -sS -X POST https://<prod-host>/admin/sync \
  -H "Authorization: Bearer <ADMIN_TOKEN>" | jq .
# → {"ok":true,"triggered":true}  (202)

# Wrong token
curl -sS -X POST https://<prod-host>/admin/sync \
  -H "Authorization: Bearer wrong" | jq .
# → {"error":"unauthorized"}  (401)
```

---

## Acceptance verification (Accept criteria, #123)

1. **Correct token → 202** (sync triggered, response immediate via `waitUntil`).
2. **Wrong token → 401** (`{"error":"unauthorized"}`), `runSync` never called.
3. **Missing header → 401** when `ADMIN_TOKEN` is set.
4. **ADMIN_TOKEN unset → pass-through** (existing back-compat: edge Access is sole guard).
5. **Cron / webhook / API unaffected** — `/api/version`, `/webhook/github`, `/api/graph`,
   `/api/issues` all respond normally without an `Authorization` header.

All five green → #123 done.
