# Getting Started

> [!NOTE]
> **Production (2026-06-08+):** Roxabi Live runs as a **Cloudflare Worker** at
> `https://live.roxabi.dev` (CF Access Email-OTP). Python/systemd/M₁ is decommissioned.
> For Worker local dev: `cd worker && npm ci && npx wrangler dev`.
> The Python setup below applies to the legacy app only.

## Prerequisites

**Worker dev (active):**
- Node.js (for `wrangler`) — `npx wrangler dev` works without a global install
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm ci` in `worker/`

**Legacy Python app (decommissioned — reference only):**
- Python 3.12 (managed via `.python-version` — `pyenv` or system install)
- [uv](https://docs.astral.sh/uv/) — package manager
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated via `gh auth login` (needs `read:org`, `repo` scopes)
- A GitHub org webhook secret (for real-time updates — optional for dev)

## Installation

```bash
git clone https://github.com/Roxabi/roxabi-live.git
cd roxabi-live
make install        # uv sync --group dev
```

## Configuration

```bash
cp .env.example .env
```

Edit `.env`:

```env
CORPUS_DB_PATH=~/.roxabi/corpus.db
GITHUB_WEBHOOK_SECRET=your-secret-here
CORPUS_SYNC_INTERVAL_SECONDS=3600
```

The corpus DB directory is created automatically on first sync.

## Initial Corpus Sync

Fetch all issues from the GitHub org into the local SQLite corpus:

```bash
make sync
# or: uv run roxabi-corpus sync
```

For a full re-sync (clears incremental sync state):

```bash
make full-sync
```

To scope to a single repo:

```bash
uv run roxabi-corpus sync --repo Roxabi/lyra
```

The sync uses `gh api graphql` — make sure `gh` is authenticated:

```bash
gh auth login
make sync
```

## Starting the Dev Server

```bash
uv run roxabi-live
```

Starts uvicorn on `http://localhost:8000`.

Endpoints:
- `http://localhost:8000/v6/` — dashboard
- `http://localhost:8000/health` — health check + DB stats
- `http://localhost:8000/api/graph` — raw graph JSON

## Webhook Setup (optional for dev)

For real-time updates, configure a GitHub org webhook:

1. Go to **GitHub org → Settings → Webhooks → Add webhook**.
2. Set the payload URL to your public endpoint, e.g. `https://your-host/webhook/github`.
3. Content type: `application/json`.
4. Set a secret and copy it to `GITHUB_WEBHOOK_SECRET` in `.env`.
5. Subscribe to: **Issues**, **Sub-issues**.

For local dev, use a tunnel (e.g. `ngrok http 8000`) to expose the local server.

See [GitHub docs — Creating webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks) for details.

## Production Deployment (Cloudflare Worker — CI-driven)

> **Decommissioned (2026-06-08):** The Python/systemd/M₁ deployment described below has been retired. See the archived sections.

Production is a Cloudflare Worker deployed via CI. Push to `main` → `wrangler deploy` (prod, `live.roxabi.dev`). Push to `staging` → `wrangler deploy --env staging`.

### Local Worker dev

```bash
cd worker && npm ci && npx wrangler dev
```

Worker binds a local D1 preview. No Python/uvicorn needed.

### Secrets (set once per environment)

```bash
printf %s '<value>' | wrangler secret put SECRET_NAME           # prod
printf %s '<value>' | wrangler secret put SECRET_NAME --env staging
```

Required secrets: `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `ADMIN_TOKEN`.

---

## Legacy: Production Deployment via systemd (decommissioned 2026-06-08)

> [!WARNING]
> M₁ (`roxabituwer`) `live.service` was stopped and disabled on 2026-06-08. The
> Python FastAPI app (`src/roxabi_live/`) is kept in the repo as a historical reference
> but is no longer deployed. `~/.roxabi/corpus.db` was archived as `.bak` on M₁.
> The sections below are preserved for reference only.

Roxabi Live was deployed as a systemd user service on M1 (`roxabituwer`). The unit is at `deploy/systemd/live.service`.

### Install (historical)

```bash
cp deploy/systemd/live.service ~/.config/systemd/user/live.service
systemctl --user daemon-reload
systemctl --user enable live.service
systemctl --user start live.service
```

### Service control (historical)

```bash
systemctl --user status live.service
journalctl --user -u live.service -f   # follow logs
```

Logs were written to `~/.local/state/roxabi-live/logs/` (archived on M₁).

### Tailscale Funnel (retired)

The Tailscale Funnel (`tailscale funnel --bg 8000`) that fronted M₁ has been retired
(`tailscale funnel --https=443 off`). Ingress is now `https://live.roxabi.dev` via
Cloudflare Access (Email-OTP).
