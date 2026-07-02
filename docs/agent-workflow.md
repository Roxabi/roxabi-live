# Agent workflow — GitHub Issues + Roxabi Live

How humans and coding agents use Roxabi Live together. GitHub remains the source of truth; the cockpit reads it and computes **ready / blocked / done** from native dependencies.

---

## The loop

```
/issue-triage  →  GitHub (labels + relations)  →  webhook/sync  →  Roxabi Live cockpit  →  launch agents on "ready"
```

1. **Structure issues in GitHub** with size, priority, lane labels, org issue type (`--type`), and native relations (`blocked-by`, parent/child).
2. **Roxabi Live syncs** via webhooks (real-time), bootstrap on login, and optional `POST /admin/sync` (cron is disabled in stock config).
3. **Open the cockpit** at [app.live.roxabi.dev](https://app.live.roxabi.dev) — pivot, list, or graph view.
4. **Launch work** only on issues whose blockers are closed and whose parent (if any) allows progress.

No Project V2 board is required. Labels + GitHub's native issue relations are enough.

---

## Install the issue-triage skill

The `roxabi-issues` plugin lives in this repo and is also published as a Claude Code marketplace plugin.

```bash
claude plugin marketplace add Roxabi/roxabi-live
claude plugin install roxabi-issues
```

Invoke as `/issue-triage` (full id: `roxabi-issues:issue-triage`).

Local development of the skill:

```bash
cd plugins/roxabi-issues
bun install
bun run typecheck
bun test
```

---

## Label vocabulary (cockpit sync)

Roxabi Live extracts metadata from GitHub labels. Use these patterns so the dashboard filters and pivot matrix work.

| Field | Label pattern | Examples |
|-------|---------------|----------|
| **Lane** | `graph:lane/<id>` | `graph:lane/b`, `graph:lane/a1`, `graph:lane/standalone` |
| **Size** | `size:<S>` or bare legacy | `size:M`, `XS`, `S`, `M`, `L`, `XL` |
| **Priority** | `priority:*` or `P0`…`P3` | `P0-critical`, `P1-high`, `P2-medium`, `P3-low` (issue-triage canonical) |
| **Type** | org issue type (not a label) | `feat`, `fix`, `epic`, `chore`, … via `--type` |

Canonical size tiers for agent planning: `S`, `F-lite`, `F-full` (aliases map to legacy sizes).

### issue-triage commands

```bash
/issue-triage list                    # tree of open issues
/issue-triage list --untriaged        # missing size or priority
/issue-triage set 42 --size M --priority High --lane b --type feat
/issue-triage set 91 --blocked-by 117
/issue-triage set 164 --parent 163
/issue-triage create --title "..." --size S --priority Medium --type feat --parent 163
```

Cross-repo refs use `owner/repo#N`:

```bash
/issue-triage set 42 --blocked-by Roxabi/lyra#728
GITHUB_REPO=Roxabi/voiceCLI /issue-triage create --title "..." --blocked-by Roxabi/lyra#728
```

Full reference: [`plugins/roxabi-issues/skills/issue-triage/SKILL.md`](../plugins/roxabi-issues/skills/issue-triage/SKILL.md).

---

## Dependency relations

Roxabi Live maps GitHub's native relations to graph edges:

| Relation | GitHub | Edge `kind` | Effect on status |
|----------|--------|-------------|------------------|
| Blocker | `blocked-by` / `blocking` | `blocks` | Open blocker → issue is **blocked** |
| Parent/child | `parent` / sub-issues | `parent` | Structural hierarchy (epic fan-out) |

**Status rules** (computed in the client via `packages/shared`; the API can filter by status server-side):

- `closed` → **done**
- Any open issue blocking this one → **blocked**
- Otherwise → **ready**

Set blockers with `/issue-triage set N --blocked-by M` or GitHub's UI. Parent/child with `--parent` / `--add-child`.

### Deferral vs decomposition

| Pattern | Parent-child? | When |
|---------|---------------|------|
| Epic → planned phase | Yes — child of epic | Up-front spec split |
| Issue → follow-up (deferred) | No — **sibling** under shared parent | Post-hoc "do later" |
| `--blocked-by` on follow-up | Yes | Traceability to origin issue |

---

## What agents should read from the cockpit

After triage, agents use Roxabi Live to answer:

- **What can I start now?** — filter status = `ready`, optionally by lane/size/priority/repo.
- **What am I blocked on?** — graph view or issue detail shows open blockers.
- **What's the epic scope?** — parent/child tree in list view or graph.

API (session cookie required — sign in via the app):

| Endpoint | Use |
|----------|-----|
| `GET /api/graph` | Full dependency graph for visible repos |
| `GET /api/issues` | Filtered issue list |
| `GET /api/issues/{owner/repo#N}` | Single issue |

Browser traffic is same-origin on `app.live.roxabi.dev` (app worker proxies to API).

---

## Recommended agent pipeline

1. **`/issue-triage`** — create or triage the issue (size, priority, lane, type, blockers, parent).
2. **`/frame` / `/spec` / `/plan`** (dev-core) — frame and plan from triaged metadata.
3. **`/dev #N`** — implement; cockpit shows when dependent issues become ready.
4. **On deferral** — create a **sibling** follow-up with `--blocked-by` pointing to the origin issue.

Complexity score κ (1–10) can be appended to the issue body as `<!-- complexity: N -->` for tier selection (S / F-lite / F-full). See the skill doc for the formula.

---

## ZK-sensitive issues

When ZK encryption is enabled, issue titles may appear as `[redacted]` in the cockpit for users without the account key. Graph structure (blockers, parent/child, status) stays visible. Agents working on ZK-sealed issues need the user's unlocked session — see [`docs/ZK_ENCRYPTION.md`](ZK_ENCRYPTION.md).

---

## Topology (for agents crawling the repo)

| Host | Role |
|------|------|
| `live.roxabi.dev` | Marketing (Astro, CF Pages) |
| `app.live.roxabi.dev` | React SPA + same-origin API proxy |
| `api.live.roxabi.dev` | Hono API, webhooks, cron (server-to-server) |

Code layout: `apps/api`, `apps/app`, `apps/marketing`, `packages/shared`, `plugins/roxabi-issues`.

---

## Further reading

- [`llms.txt`](../llms.txt) — compact index for LLM crawlers
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — system design
- [`CLAUDE.md`](../CLAUDE.md) — maintainer/agent instructions for this repo
- [`plugins/roxabi-issues/skills/issue-triage/README.md`](../plugins/roxabi-issues/skills/issue-triage/README.md) — skill quick reference