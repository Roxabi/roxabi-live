# Security Audit — #43 Webhook

**Scope:** src/roxabi_live/webhook/{hmac_auth,router,handlers}.py
**Date:** 2026-04-24
**Verdict:** APPROVED

## Summary

The webhook HMAC verification is correctly implemented using `hmac.compare_digest` on raw body bytes before JSON parsing, with no secret leakage in logs or responses. One low-severity issue noted: empty-string secret fallback silently accepts forged requests when `GITHUB_WEBHOOK_SECRET` is unset.

## Findings

### ✓ Constant-time compare — pass
`hmac_auth.py:26` — `hmac.compare_digest(expected, received)` is used exclusively. No `==` comparison on the signature anywhere in the module.

### ✓ Raw body — pass
`router.py:48–50` — `body = await request.body()` is captured first; `hmac_auth.verify(body, ...)` is called before `await request.json()` on line 53. HMAC runs against the original wire bytes.

### ✓ 401 information leak — pass
`router.py:51` — Single undifferentiated `detail="invalid signature"` is returned for both missing-header and wrong-signature cases. No oracle.

### ✓ Secret in logs/errors — pass
No `log.*` calls exist in any of the three webhook files. `app.py` uses `logging` but only logs reconciler lifecycle events. Secret value never appears in any log, exception, or response body.

### ✓ Timing side channels — pass
`hmac_auth.py:22–26` — The only early return is `if not header or not header.startswith(PREFIX)`, which is structural (header absent/malformed), not length-based on the signature itself. `compare_digest` then handles the constant-time comparison of hex strings of identical length (64 chars), so no length leak.

### ✓ Missing events — pass
`router.py:68–69` — Unknown `X-GitHub-Event` values return `{"ok": True, "ignored": x_github_event}` with HTTP 200. No handler work is triggered. Logging the unknown event type in the response is cosmetic and carries no security impact.

### ✓ Signature format — pass
`hmac_auth.py:8,22` — `PREFIX = "sha256="` is enforced via `header.startswith(PREFIX)`. No weaker algorithm (`sha1=`) is accepted.

### ✓ Replay protection — noted (by design)
No replay protection (nonce, timestamp, `X-GitHub-Delivery` deduplication). This is standard for GitHub webhooks — GitHub does not sign timestamps and the spec does not require it. Noted as an accepted risk, not a finding.

### ✓ JSON parse errors — pass
`router.py:53` — `await request.json()` is called with no try/except. FastAPI/Starlette will surface a 400 or 422 with its standard error body (no stack trace in production mode). No bare `except` that could leak internals.

### ✓ Path traversal / SQL injection — pass
`handlers.py` — All DB operations use parameterized queries (`?` placeholders) throughout:
- Lines 21, 25–47, 50, 57 (`handle_issues`)
- Lines 80–85, 92–96 (`handle_deps`)
- Lines 118–122, 130–134 (`handle_sub_issues`)

The `key` values (`f"{repo}#{issue['number']}"`) are passed as bound parameters, not interpolated into query strings.

### ⚠ Empty-string secret fallback — issue

**File:** `router.py:49`

```python
secret = os.environ.get("GITHUB_WEBHOOK_SECRET", "")
```

**Severity: low**

If `GITHUB_WEBHOOK_SECRET` is unset (e.g., misconfigured deployment), `secret` becomes `""`. `hmac.new(b"", body, sha256)` is still a valid HMAC; an attacker who knows the secret is empty (or who can test it) can forge valid signatures trivially.

**Suggested fix:** Fail fast at startup rather than silently accepting an empty secret.

```python
secret = os.environ.get("GITHUB_WEBHOOK_SECRET") or ""
if not secret:
    raise HTTPException(status_code=503, detail="webhook not configured")
```

Better: validate at app startup (lifespan) and refuse to start if the secret is absent, so the misconfiguration is caught before any requests are served.
