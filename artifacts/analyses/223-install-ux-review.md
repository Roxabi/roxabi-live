# Code Review — PR #223: Guided GitHub App Install UX

**Branch reviewed:** `staging` @ `6fcc30ff`
**Commits in scope:** `66bf7464`, `1baf1259`, `b2cd4c01`
**Review date:** 2026-06-19
**Reviewer:** Claude Sonnet 4.6 (automated post-merge review)

---

## Scope

| File | Role |
|---|---|
| `worker/src/api/install-complete.ts` | `GET /install/complete` callback handler |
| `worker/src/auth/github-install.ts` | URL builder + `parseInstallTargets` |
| `worker/migrations/0017_install_pending_session.sql` | `tenant_id` nullable + `install_targets_json` column |
| `worker/src/auth/repoAccess.ts` | Fail-closed repo access (commit `1baf1259`) |
| `worker/src/auth/oauth.ts` | Zero-install branch (pending session) |
| `worker/src/auth/session.ts` | `mintSession(null)` + `requireLinkedTenant` middleware |
| `worker/src/router.ts` | Route-level gating assignments |
| `worker/src/api/me.ts` | `install_pending` / `install_targets` response fields |
| `frontend/github-install.js` | `githubInstallUrl` + `partitionInstallTargets` |
| `frontend/auth.js` | `resolveView` + `renderInstallCta` (caller side) |

---

## Findings

### [praise] Auth isolation — install-pending sessions correctly blocked from all data routes

`requireLinkedTenant` (session.ts) returns 401 when `ctx.tenantId == null`. Every data-returning endpoint (`/api/graph`, `/api/issues`, `/api/issues/*`, all `/api/zk/*`, `/api/sync/status`, `/api/active-tenant`) uses this middleware (verified in `router.ts`). Install-pending users can only reach `/api/me` (`requireSession` — intentional, needed to render the install CTA). No data IDOR vector exists for pending sessions.

**Confidence:** high — manually traced every route in `router.ts` + cross-checked middleware assignments.

---

### [praise] Session SQL — null tenantId handled correctly

`validateSession` uses:

```sql
AND (
  s.tenant_id IS NULL
  OR (
    NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = s.tenant_id AND t.suspended_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM user_installations ui WHERE ui.user_id = s.user_id AND ui.tenant_id = s.tenant_id)
  )
)
```

This is a correct implementation: pending sessions (null) pass the outer condition while linked sessions still require the tenant to be active and the user-installation link to exist. The test in `session.test.ts` directly asserts on the SQL string — will catch accidental regressions.

---

### [praise] Fail-closed `repoAccess.ts` (commit `1baf1259`)

Change is minimal and exactly right:

```typescript
if (!s || s.tenantId == null) { return []; }
```

All three steps of `checkPrivateAccess` were already fail-closed (empty cache miss → 401, API error → deny). This one change ensures install-pending sessions never reach the GitHub Collaborators API call. Test coverage for the null branch exists in `repoAccess.test.ts` (verified via grep — test file present).

---

### [praise] Open-redirect prevention — install-pending path

The redirect in the zero-install branch:

```typescript
const installDest = new URL(redirectAfter, origin);
installDest.searchParams.set("install", "1");
return new Response(null, {
  status: 302,
  headers: { Location: `${installDest.pathname}${installDest.search}`, ... },
});
```

Only `pathname + search` are used — the host is stripped. `redirectAfter` was already sanitized by `sanitizeRedirect()` at the top of `callbackRoute`. No open-redirect possible.

---

### [praise] XSS safety in frontend install CTA

All user-controlled strings rendered via `innerHTML` are passed through `escHtml()` (verified in `auth.js`):
- `org.login` → `escHtml(org.login)`
- `githubInstallUrl(org)` → `escHtml(githubInstallUrl(org))`
- `me.user.github_login` → `escHtml(me.user.github_login)`

No injection surface in the install CTA rendering path.

---

### [issue] `partitionInstallTargets` — missing array guard

**Severity:** low | **Confidence:** high | **Fixed in this PR**

```js
// frontend/github-install.js — before fix
export function partitionInstallTargets(targets) {
  const personal = targets.find(t => t.type === 'User') ?? null;
  const orgs = targets.filter(t => t.type === 'Organization');
  return { personal, orgs };
}
```

If `targets` is not an array (e.g., `null`, `undefined`, or an unexpected API shape), `.find()` and `.filter()` throw a `TypeError`. The caller in `auth.js` always passes `me.install_targets ?? []`, which means real-world risk is near-zero (the API always returns an array or the nullish coalescing guard fires). However, a defensive guard prevents silent failures from unexpected API changes or direct invocations.

**Fix applied:** Added `Array.isArray(targets)` guard at top of function. Added a test for null and undefined inputs.

---

### [nitpick] `parseInstallTargets` — no happy-path test

**Severity:** low | **Confidence:** high | **Fixed in this PR**

`worker/src/auth/github-install.test.ts` tests null/empty/invalid JSON and malformed entry filtering — but has no test confirming valid entries pass through unmodified. This is a gap: if the filter predicate were accidentally inverted, valid entries would be stripped and no test would catch it.

**Fix applied:** Added a test case with a valid multi-entry array (User + Organization) asserting they pass through unchanged.

---

### [nitpick] Org pagination capped at 100

**Severity:** low (UX-only) | **Confidence:** high | **Not fixed**

```typescript
await fetch("https://api.github.com/user/orgs?per_page=100", { headers: ghHeaders })
```

GitHub returns at most 100 orgs per page. A user in >100 orgs will see a truncated org list in the install CTA. This is a UX gap, not a security issue — the install will still succeed regardless of which account is picked, and GitHub's install flow handles the rest. Pagination would require follow-up calls and error recovery; out of scope for this review.

---

### [nitpick] `GITHUB_APP_SLUG` duplicated across TS and JS

**Severity:** informational | **Confidence:** high | **Not fixed**

`GITHUB_APP_SLUG = "roxabi-live"` exists in both `worker/src/auth/github-install.ts` and `frontend/github-install.js`. No runtime risk — both are served from the same repo. If the app slug ever changes it requires updating two files. A future improvement would be to inject the slug via Worker env at build time.

---

### [nitpick] `zk_opt_in=1` always written on login

**Severity:** informational | **Confidence:** medium | **Not fixed**

Both the install-pending upsert and the normal upsert unconditionally set `zk_opt_in=1`. This appears intentional (ZK is opt-in by consent flow, not by this DB field alone) but the field name is misleading if it always equals 1. Flagging for visibility — no action required if this is by design.

---

### [nitpick] Stale `install_targets_json` window

**Severity:** informational | **Confidence:** high | **Not fixed**

`install_targets_json` is populated at login-time and cleared to `NULL` on the next successful login (when installations exist). Between first login (no installs) and re-login (after installing), the org list is frozen. If the user joins a new org during that window, it won't appear in the CTA until they log out and back in. Acceptable for a first-ship UX; could be mitigated with a refresh endpoint later.

---

## Fixes Applied

Two low-severity defensive fixes were applied in the same branch:

| # | File | Change |
|---|---|---|
| 1 | `frontend/github-install.js` | Added `Array.isArray(targets)` guard to `partitionInstallTargets` |
| 2 | `frontend/github-install.test.js` | Added tests for null/undefined input to `partitionInstallTargets` |
| 3 | `worker/src/auth/github-install.test.ts` | Added happy-path test for `parseInstallTargets` with valid entries |

---

## Verdict

**LGTM with minor notes.** The core security invariants are sound:

- Install-pending sessions cannot access any tenant data (router gating verified).
- The session SQL null-tenantId handling is correct and directly tested.
- The fail-closed change in `repoAccess.ts` is minimal and correct.
- No IDOR, open-redirect, or XSS vectors found.

The two test gaps and one defensive guard are the only actionable findings; all three are low-severity and fixed in this branch. Informational notes (org pagination, slug duplication, zk_opt_in semantics, stale targets) are logged for awareness but require no immediate action.
