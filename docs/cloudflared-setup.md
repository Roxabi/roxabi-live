---
title: Cloudflared Tunnel Setup
description: One-time provisioning of the Cloudflare Tunnel that exposes dashboard.roxabi.dev, and migration from M₂ to M₁.
---

## Overview

`cloudflared` runs as a supervised daemon that creates an outbound-only Cloudflare Tunnel from the host machine to the public domain `dashboard.roxabi.dev`. All HTTP traffic arriving at that domain is forwarded to the local FastAPI process on port 8000. No inbound firewall ports are opened; the tunnel is the sole ingress path.

## Prerequisites

- `cloudflared` binary installed and on `$PATH` (download from [cloudflare.com/products/tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))
- A Cloudflare account with access to the `roxabi.dev` zone
- The domain `roxabi.dev` added to the Cloudflare account with NS records delegated to Cloudflare
- `CLOUDFLARED_TUNNEL_NAME` set in the supervisord environment (see `.env.example`)

## One-Time Tunnel Provisioning

Run these steps once on the machine that will host the tunnel (M₂ initially, M₁ later).

**Step 1 — Authenticate to Cloudflare**

```bash
cloudflared tunnel login
```

Opens a browser to authorize `cloudflared`. On success, saves a certificate to `~/.cloudflared/cert.pem`.

**Step 2 — Create the tunnel**

```bash
cloudflared tunnel create dashboard-roxabi
```

Saves a credentials JSON file to `~/.cloudflared/<tunnel-id>.json` and prints the tunnel ID. Note the tunnel ID — it is needed in step 3.

**Step 3 — Route DNS**

In the Cloudflare dashboard (or via CLI), add a CNAME record:

```
dashboard.roxabi.dev  →  <tunnel-id>.cfargotunnel.com
```

Via CLI:

```bash
cloudflared tunnel route dns dashboard-roxabi dashboard.roxabi.dev
```

**Step 4 — Create the config file**

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: dashboard-roxabi
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: dashboard.roxabi.dev
    service: http://localhost:8000
  - service: http_status:404
```

Replace `<user>` and `<tunnel-id>` with actual values.

**Step 5 — Set the environment variable**

Add to the supervisord environment or `.env`:

```
CLOUDFLARED_TUNNEL_NAME=dashboard-roxabi
```

The supervisord unit reads this via `%(ENV_CLOUDFLARED_TUNNEL_NAME)s` — see `deploy/supervisor/conf.d/cloudflared.conf`.

**Step 6 — Start the tunnel**

```bash
make cloudflared start
```

Or via supervisorctl directly:

```bash
supervisorctl start cloudflared
```

## Starting the Tunnel via Supervisord

The supervisord unit is defined in `deploy/supervisor/conf.d/cloudflared.conf`. Key settings:

| Setting | Value | Notes |
|---------|-------|-------|
| `command` | `cloudflared tunnel --config ~/.cloudflared/config.yml run <name>` | Config path resolved from `$HOME` |
| `autostart` | `false` | Manual start on M₂ (dev); set to `true` on M₁ (prod) |
| `autorestart` | `true` | Restarts on crash |
| `priority` | `200` | Starts after FastAPI (`live` program) |
| `stdout_logfile` | `~/.local/state/roxabi-live/logs/cloudflared.out.log` | |
| `stderr_logfile` | `~/.local/state/roxabi-live/logs/cloudflared.err.log` | |

The log directory `~/.local/state/roxabi-live/logs/` must exist before starting. Create it with:

```bash
mkdir -p ~/.local/state/roxabi-live/logs
```

## Verifying

Once both the FastAPI process and the tunnel daemon are running:

```bash
curl https://dashboard.roxabi.dev/health
```

Expected response:

```json
{
  "status": "ok",
  "db": "~/.roxabi/corpus.db",
  "db_reachable": true,
  "issue_count": 312
}
```

If `db_reachable` is `false`, corpus.db is missing or unreadable. Check `CORPUS_DB_PATH` and that lyra's reconciler has run at least once.

## M₂ → M₁ Migration

When M₂ (dev, Pop!_OS) has been running stably and M₁ (roxabituwer, Ubuntu Server, 24/7) is ready to take over, follow these steps.

**Step 1 — Copy corpus.db to M₁**

```bash
rsync ~/.roxabi/corpus.db roxabituwer:~/.roxabi/
```

**Step 2 — Copy cloudflared credentials to M₁**

Option A — copy existing credentials (tunnel stays the same):

```bash
rsync -r ~/.cloudflared/ roxabituwer:~/.cloudflared/
```

Option B — re-authenticate on M₁ (`cloudflared tunnel login`) and reuse the same tunnel name; the tunnel ID and DNS record do not change.

**Step 3 — Start the supervisord stack on M₁**

On M₁, ensure the supervisord configuration is deployed, then start both programs:

```bash
supervisorctl start live cloudflared
```

Set `autostart=true` in both `.conf` files on M₁ so they survive reboots.

**Step 4 — Flip tunnel ingress target (if using a new tunnel)**

If a new tunnel was created on M₁, update the Cloudflare DNS CNAME to point at the new tunnel ID:

```bash
# On M₁
cloudflared tunnel route dns dashboard-roxabi dashboard.roxabi.dev
```

If credentials were copied (Step 2 Option A), no DNS change is needed — the same tunnel ID is reused.

**Step 5 — Verify through the tunnel from an external machine**

From any machine outside both M₁ and M₂:

```bash
curl https://dashboard.roxabi.dev/health
```

Confirm `db_reachable: true` and that `issue_count` reflects current corpus state.

**Step 6 — Stop cloudflared and FastAPI on M₂**

Once M₁ is confirmed serving traffic:

```bash
# On M₂
supervisorctl stop cloudflared live
```

Set `autostart=false` for both programs on M₂ to prevent them from restarting after reboot.

## Cloudflare Access (zero-trust gate)

`corpus.db` contains issues from private repos. Cloudflare Access sits in front of the tunnel and redirects unauthenticated browsers to an identity provider. The GitHub webhook bypasses the gate via a service-token policy so deliveries still land at `/webhook/github`.

### Step A — Create the Access application

1. Zero Trust dashboard → **Access** → **Applications** → **Add application** → **Self-hosted**.
2. Application name: `Roxabi Live Dashboard`.
3. Subdomain: `dashboard`. Domain: `roxabi.dev`.
4. Session duration: `24h`.
5. **Policies** → **Add policy**
   - Name: `Allow owner`
   - Action: `Allow`
   - Include selector: `Emails` → `mickael@bouly.io`
6. Save the application.

### Step B — Bypass webhook via service token

1. Zero Trust → **Access** → **Service Auth** → **Service Tokens** → **Create Service Token**.
2. Name: `github-webhook`. Duration: non-expiring (or set a rotation cadence).
3. Copy `Client ID` and `Client Secret` immediately — the secret is shown once.
4. Back in the `Roxabi Live Dashboard` application → **Policies** → **Add policy**
   - Name: `GitHub webhook bypass`
   - Action: `Service Auth`
   - Include selector: `Service Token` → `github-webhook`
5. Keep this policy *above* any `Deny` / `Require` policies so it evaluates first for tokenized requests. Save.

### Step C — Attach the service token to the GitHub webhook

GitHub's built-in webhook UI does not support custom headers directly. Two options:

- **Option 1 — Cloudflare Worker trampoline (recommended):** deploy a small worker on a separate subdomain (e.g. `webhook-ingest.roxabi.dev`, not protected by Access) that injects `CF-Access-Client-Id` + `CF-Access-Client-Secret` on every inbound request and proxies to `https://dashboard.roxabi.dev/webhook/github`. Point the GitHub webhook at the worker URL.
- **Option 2 — GitHub App with custom headers:** replace the repo webhook with a GitHub App; GitHub Apps allow custom headers via their delivery config.

Either way, every proxied request to `dashboard.roxabi.dev/webhook/github` must carry:

```
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
```

Store `Client Secret` in the worker's secret binding (never commit). Rotate via Step B on secret leak.

### Step D — Verify

Unauthenticated browser / curl:

```bash
curl -sI https://dashboard.roxabi.dev/api/issues | head -1
# expected:  HTTP/2 302
# Location redirect to <team>.cloudflareaccess.com
```

Webhook delivery:

1. GitHub repo → **Settings** → **Webhooks** → pick `/webhook/github` → **Recent Deliveries**.
2. Hit **Redeliver** on the most recent event.
3. Response must be `200 OK`. If `302` is returned, the service-token headers are not reaching Cloudflare — re-check Step C.

### Rotation

- Rotate the service token: Zero Trust → Service Tokens → `github-webhook` → **Refresh**. Update the worker secret. Redeliver a test webhook to confirm.
- Rotate the identity-provider allowlist: edit the `Allow owner` policy (Step A.5).
- After a `_halted` reconciler event (CRITICAL log emitted due to repeated auth failures): rotate the GitHub token, then restart the `live` supervisor program to clear the sticky halt state: `supervisorctl restart live`. The reconciler will resume on the next hourly tick.
