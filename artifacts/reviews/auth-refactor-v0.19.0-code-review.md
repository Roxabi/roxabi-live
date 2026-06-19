# Code Review — Auth refactor v0.19.0

**Scope:** `git diff 374421c6..HEAD` (31 files, −264 LOC net)  
**Release:** `0.19.0`  
**Date:** 2026-06-19  
**Agents:** security-auditor, backend-dev, frontend-dev, tester

---

## Verdict: **Request changes**

Direction is correct (server-owned onboarding, drop exchange hop, webhook install link). Ship fixes for **session-upgrade correctness**, **suspended-tenant filter**, **`mustReOAuth` over-trigger**, and **test gaps** on new routes before treating v0.19.0 as done.

---

## Blockers

### issue: `setSessionTenant` success not verified before returning `status: "linked"`
`worker/src/api/install-refresh.ts:49-60` — backend-dev — **Confidence: 90%**

Handler mutates in-memory `s.tenantId` and returns `linked` even if D1 `UPDATE` affected 0 rows (expired session between middleware and handler).

**Fix:** Check update row count or re-`validateSession`; return `401` on failure.

---

### issue: Suspended tenants not excluded from install-refresh auto-link
`worker/src/api/install-refresh.ts:26-30` — backend-dev — **Confidence: 88%**

Query filters `deleted_at` but not `suspended_at`. User can get `200 linked` then immediate `401` on next gated request.

**Fix:** Add `AND t.suspended_at IS NULL`; mirror `active-tenant.ts` guards.

---

### issue: `mustReOAuth` forces full OAuth when webhook linked user but `tenantId` still null
`worker/src/auth/oauth.ts:56-76` — backend-dev — **Confidence: 85%**

`intent=install` + `tenantId === null` → OAuth even when `user_installations` already populated. Undermines `oauth_fallback` and install-refresh path.

**Fix:** If `user_installations` count > 0, short-circuit to dashboard redirect (no GitHub).

---

### issue: XSS in `authNavigateHtml` slow-session fallback
`worker/src/auth/post-oauth.ts:51` — security-auditor — **Confidence: 88%**

`sanitizeAuthRedirect` allows `"`, `<`, `>` in paths; `innerHTML` concatenation with `next` enables XSS on ZK/reauth flows.

**Fix:** HTML-encode `safeDest` in template or tighten redirect allowlist.

---

### issue: No route tests for `POST /api/install/refresh` or `POST /api/consent`
— tester — **Confidence: 95%**

New primary APIs untested; webhook sender link in `handlers-app.ts` also untested.

**Fix:** Add `install-refresh.test.ts`, `consent.test.ts`, extend `handlers-app.test.ts` + `me.test.ts`.

---

## Warnings

### suggestion: `oauth_fallback` returned by server but ignored by client
`worker/src/api/install-refresh.ts:41` / `frontend/auth.js:167` — backend-dev, frontend-dev — **Confidence: 90%**

Client hardcodes reconnect URL; server field is dead.

**Fix:** Use `body.oauth_fallback` in install-timeout hint.

---

### suggestion: `ORDER BY tenant_id` picks wrong org for multi-install users
`worker/src/api/install-refresh.ts:48` — backend-dev — **Confidence: 75%**

Lowest PK ≠ installation just completed.

**Fix:** Optional `installation_id` in POST body or skip auto-switch when count > 1.

---

### issue: Silent consent POST / auto-migration failures
`frontend/auth.js:234-242`, `39-48` — frontend-dev — **Confidence: 85%**

User gets no feedback on failure.

**Fix:** Surface error in consent dialog / `#error-msg`.

---

### suggestion: CSRF defense-in-depth missing on POST mutations
`worker/src/router.ts:102-106` — security-auditor — **Confidence: 75%**

Relies on `SameSite=Lax` only; router comment incorrectly says `Strict` for logout.

**Fix:** Origin/Referer host check on POST; fix comment.

---

### suggestion: Concurrent sessions not revoked on OAuth success
`worker/src/auth/oauth.ts:353` — security-auditor — **Confidence: 80%**

Each login mints new session without revoking prior tokens.

**Fix:** Revoke other active sessions for `userId` on OAuth success.

---

### issue: Frontend gate tests removed without replacement
`frontend/auth.test.js` — frontend-dev, tester — **Confidence: 90%**

`requireAuthGate`, `pollInstallRefresh`, `migrateLegacyConsent` untested.

**Fix:** Vitest mocks for step routing and install poll.

---

## Praise

- **Post-OAuth 200 + Set-Cookie** eliminates exchange hop and redirect-loop class (`post-oauth.ts`, `oauth.ts`).
- **Server-owned `onboarding_step`** centralizes install/consent/ready (`onboarding.ts`, `me.ts`).
- **Webhook batching** for sender → `user_installations` is atomic and idempotent (`handlers-app.ts`).
- **702 worker + 48 frontend tests green**; oauth callback paths updated for inline dashboard serve.

---

## Recommended next step

**/fix** — address blockers 1–3 + XSS + minimal route tests, then re-review.