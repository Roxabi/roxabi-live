# Getting Started

## Prerequisites

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

## Production Deployment (supervisord)

Roxabi Live is deployed via supervisord on M1 (`roxabituwer`). The supervisor unit is at `deploy/supervisor/conf.d/live.conf`.

### Register with the hub

Run once on the target machine:

```bash
make register
```

This links `deploy/supervisor/conf.d/live.conf` into the hub supervisor and creates the log directory at `~/.local/state/roxabi-live/logs/`.

### Service control

```bash
make live           # sync corpus then start
make live start     # start only
make live stop      # stop
make live status    # supervisor status
make live logs      # tail live.log
make live reload    # restart
```

Logs are written to `~/.local/state/roxabi-live/logs/`:
- `live.log` — stdout
- `live_error.log` — stderr
- `supervisord.log` — supervisor daemon log

### Tailscale Funnel

On M1, the server is exposed publicly via Tailscale Funnel. No additional config is required beyond the standard Tailscale setup.
