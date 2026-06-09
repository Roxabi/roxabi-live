---
name: issue-triage
argument-hint: [list | set <num> | create --title "..." [--parent N] [--size S] [--priority P] [--type T] [--lane L]]
description: Triage/create GitHub issues — set size/priority/lane/type labels, manage dependencies & parent/child. Triggers: "triage" | "create issue" | "set size" | "set priority" | "blocked by" | "set parent" | "child of" | "sub-issue" | "file an issue" | "log a bug" | "open an issue" | "file a bug" | "add issue" | "new issue" | "set lane" | "set type".
version: 0.4.0
allowed-tools: Bash, Read, ToolSearch
---

# Issue Triage

Let: τ := `bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts` | κ := complexity score

Create GitHub issues, assign Size/Priority labels, manage blockedBy dependencies and parent/child relationships.

## Instructions

1. List all open issues: `τ list` | List untriaged only: `τ list --untriaged`
2. ∀ issue: determine Size, Priority, κ (see [Complexity Scoring](#complexity-scoring))
3. Set values: `τ set <number> --size <S> --priority <P>`
4. Create issues: `τ create --title "Title" [--body "Body"] [--label "bug,frontend"] [--size M] [--priority High] [--type feat] [--lane b] [--parent 163]`
5. → DP(B)if unsure about Size ∨ Priority.

## Size Guidelines

| Size | Description | Example |
|------|-------------|---------|
| **XS** | Trivial, < 1 hour | Typo fix, config tweak |
| **S** | Small, < 4 hours | Single file change, simple feature |
| **M** | Medium, 1-2 days | Multi-file feature, requires testing |
| **L** | Large, 3-5 days | Complex feature, architectural changes |
| **XL** | Very large, > 1 week | Major refactor, new system |

**Canonical tier names:** `S / F-lite / F-full` (maps to dev tiers: S=simple, F-lite=subagents, F-full=agent team). Legacy size labels use `XS / S / M / L / XL`. Both are accepted as `--size` input. When a canonical name is used it aliases to the nearest size label (`F-full`→`XL`/`L`, `F-lite`→`M`, `S`→`S`/`XS`) — this is expected presentation drift, not a bug.

## Priority Guidelines

| Priority | Description | Action |
|----------|-------------|--------|
| **Urgent** (P0) | Blocking or critical | Do immediately |
| **High** (P1) | Important for current milestone | Do this sprint |
| **Medium** (P2) | Should be done soon | Plan for next sprint |
| **Low** (P3) | Nice to have | Backlog |

## Commands

### `list` — Show open issues

| Flag | Description |
|------|-------------|
| *(none)* | Tree of all open issues with N-level parent-child hierarchy. Parents with ≥1 closed child show `… ✓ Done`. |
| `--untriaged` | Flat table of issues missing Size or Priority |
| `--json` | JSON output (all open issues); combine with `--untriaged` to filter |

### `set <num>` — Update an existing issue

| Flag | Description |
|------|-------------|
| `--size <S>` | Set size label — canonical `S/F-lite/F-full` or legacy `XS/S/M/L/XL` (canonical names alias to nearest legacy label) |
| `--priority <P>` | Set priority label (Urgent, High, Medium, Low) |
| `--blocked-by <REF>[,<REF>...]` | Add blocked-by dependency. REF = `#N` or `owner/repo#N` |
| `--blocks <REF>[,<REF>...]` | Add blocking dependency. REF = `#N` or `owner/repo#N` |
| `--rm-blocked-by <REF>[,<REF>...]` | Remove blocked-by dependency |
| `--rm-blocks <REF>[,<REF>...]` | Remove blocking dependency |
| `--parent <REF>` | Set parent issue. REF = `#N` or `owner/repo#N` |
| `--add-child <REF>[,<REF>...]` | Add child sub-issues |
| `--rm-parent` | Remove parent relationship |
| `--rm-child <REF>[,<REF>...]` | Remove child sub-issues |
| `--lane <L>` | Set lane label (optional, additive). Valid: `a1`, `a2`, `a3`, `b`, `c1`, `c2`, `c3`, `d`–`o`, `standalone` |
| `--type <T>` | Set org issueType (optional, additive). Valid: `fix`, `feat`, `docs`, `test`, `chore`, `ci`, `perf`, `epic`, `research`, `refactor` |

### `create` — Create a new issue

| Flag | Description |
|------|-------------|
| `--title "..."` | Issue title (**required**) |
| `--body "..."` | Issue body/description |
| `--label "l1,l2"` | Comma-separated labels |
| `--size <S>` | Set size on creation — canonical `S/F-lite/F-full` or legacy `XS/S/M/L/XL` accepted |
| `--priority <P>` | Set priority on creation |
| `--lane <L>` | Set lane on creation (label-only, additive). Valid: `a1`, `a2`, `a3`, `b`, `c1`, `c2`, `c3`, `d`–`o`, `standalone` |
| `--type <T>` | Set org issueType on creation (additive). Valid: `fix`, `feat`, `docs`, `test`, `chore`, `ci`, `perf`, `epic`, `research`, `refactor` |
| `--parent <REF>` | Set parent issue on creation. REF = `#N` or `owner/repo#N` |
| `--add-child <REF>[,<REF>...]` | Add existing issues as children |
| `--blocked-by <REF>[,<REF>...]` | Set blocked-by on creation |
| `--blocks <REF>[,<REF>...]` | Set blocking on creation |

### Cross-repo create

Set `GITHUB_REPO=<owner/repo>` to retarget the CREATE to a different repo than the cwd's git remote:

```bash
# File a voiceCLI issue while cwd is lyra (or any other repo)
GITHUB_REPO=Roxabi/voiceCLI τ create \
  --title 'STT: audio dropout at segment boundary' \
  --blocked-by Roxabi/lyra#728
```

Cross-repo **relations** (`--blocked-by`, `--blocks`, `--parent`, `--add-child`) accept `OWNER/REPO#N` natively — they work regardless of `GITHUB_REPO`.

**Caveat — keep refs fully-qualified:** `GITHUB_REPO` retargets the entire invocation. A bare `#N` in any ref resolves against the overridden repo, not the cwd repo → always use `OWNER/REPO#N` for any cross-repo ref when the env var is set.

**Resolution order** (`detectGitHubRepo`): (1) `github_repo` in dev-core config ∨ `GITHUB_REPO` env var (validated as `owner/repo`) → (2) fallback `git remote get-url origin` of the cwd.

## Deferred Follow-Ups — Sibling Rule

**Defer ≠ decomposition.** When an issue A defers work to a new follow-up B (out-of-scope finding, post-merge gap, "do this later"), B is a **sibling** of A under their shared parent — NOT a child of A.

```
       Epic E
      ╱      ╲
     A ←—————— B     B.parent = A.parent (= E)
       blocked-by    B.blocked-by = A   (traceability of origin)
```

**Why:**
- `gh issue view E` shows the full fan-out flat (A + B + future C…) — true scope of the epic, ¬nested cascade
- `/dev` re-scan retombe correctement sur l'épic origin pour tout follow-up
- Multi-level deferrals (A→B→C) stay flat under E — ¬arbre profond ingérable

**Decomposition vs deferral:**

| Pattern | Parent-child? | Example |
|---------|---------------|---------|
| **Epic → phase** (planned decomposition) | ✓ child of epic | `/spec` smart-splitting: phase 1, phase 2 are children of epic |
| **Issue → follow-up** (deferral, post-hoc) | ✗ sibling under shared parent | `/fix` Phase 5 Defer: out-of-scope finding becomes sibling |
| **Bug → regression** (related ¬caused) | ✗ standalone | New bug surfaced post-merge, ¬child, ¬sibling necessarily |

**Recipe — defer A → create follow-up B:**

```bash
# 1. Resolve A's parent (may be null if A is top-level)
A_PARENT=$(gh api graphql -f query="query{repository(owner:\"$OWNER\",name:\"$REPO\"){issue(number:$A){parent{number}}}}" \
  --jq '.data.repository.issue.parent.number // empty')

# 2. Create B as sibling: same parent as A, blocked-by A
τ create \
  --title "{deferred title}" \
  --body "**Origin:** #${A} (deferred from ...)\n\n{details}" \
  --blocked-by "#${A}" \
  ${A_PARENT:+--parent "#${A_PARENT}"}
```

**Edge cases:**
- A has no parent → B has no parent either (both top-level). Consider whether A should be re-parented under a freshly-created epic if the fan-out grows.
- A is already top-level epic → defer creates child of A (epic decomposition pattern applies).
- Existing follow-up issue B mis-parented under A → fix retroactively:
  ```bash
  τ set <B> --rm-parent
  τ set <B> --parent "#${A_PARENT}"
  τ set <B> --blocked-by "#${A}"  # ensure traceability link
  ```

## Complexity Scoring

Assess κ ∈ [1,10] to inform tier (S / F-lite / F-full). Record by appending to issue body:

```bash
BODY=$(gh issue view <number> --json body --jq .body)
gh issue edit <number> --body "$BODY

<!-- complexity: <score> -->"
```

`<!-- complexity: N -->` is machine-parseable; downstream tools (e.g. `/plan`) read it.

**Factors (each 1-10, weighted):**

| Factor | Weight | 1 (Low) | 5 (Medium) | 10 (High) |
|--------|--------|---------|------------|-----------|
| **Files touched** | 20% | 1-3 files | 5-10 files | 15+ files |
| **Technical risk** | 25% | Known patterns | New library/pattern in 1 domain | New architecture |
| **Architectural impact** | 25% | Single module | Shared types, 2 modules | Cross-domain, new abstractions |
| **Unknowns count** | 15% | 0 unknowns | 1-2 open questions | 3+ unknowns |
| **Domain breadth** | 15% | 1 domain | 2 domains | 3+ domains |

**Formula:** `κ = round(files × 0.20 + risk × 0.25 + arch × 0.25 + unknowns × 0.15 + domains × 0.15)`

**Tier mapping:**

| Score | Tier | Process | Agent Mode |
|-------|------|---------|-----------|
| 1-3 | **S** | Worktree + direct implementation + PR | Single session, no agents |
| 4-6 | **F-lite** | Worktree + subagents + /code-review | Task subagents (1-2 domain + tester) |
| 7-10 | **F-full** | Bootstrap + worktree + agent team + /code-review | TeamCreate (3+ agents, test-first) |

κ is advisory. Human judgment overrides. → DP(B)if score ≠ intuition.

See [Tier Classification Reference](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/tier-classification.md) for full rules.
Reference: `artifacts/analyses/280-token-consumption.mdx` for scoring examples.

## Example Workflow

```bash
τ list
τ list --untriaged
τ set 42 --size M --priority High
τ set 91 --blocked-by 117
τ set 117 --blocks 91,118
τ set 91 --rm-blocked-by 117
τ set 164 --parent 163
τ set 163 --add-child 164,165,166
τ set 164 --rm-parent
τ set 163 --rm-child 166

# Cross-repo dependencies (owner/repo#N format)
τ set 42 --blocked-by Roxabi/lyra#728
τ set 42 --blocks Roxabi/voiceCLI#94

τ create \
  --title "research: compare against example/repo" \
  --body "Deep analysis of example/repo" \
  --label "research" \
  --size S --priority Medium \
  --parent 163
τ create \
  --title "epic: improve CI pipeline" \
  --size L --priority High \
  --add-child 150,151,152

# Lane and type (additive, optional)
τ set 42 --lane b
τ set 42 --type feat
τ set 42 --size M --priority High --lane c1 --type fix
```

## Chain Position

- **Phase:** Frame
- **Predecessor:** — (entry point)
- **Successor:** `/frame`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Success via `/dev`:** return control silently. ¬write summary. ¬ask user. ¬announce `/frame`. `/dev` re-scans and advances.
- **Success standalone:** print one line: `Done. Next: /frame --issue N`. Stop.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.

## Related

- [Taxonomy SSoT](../../references/issue-taxonomy.md) — field set, cross-repo behavior, plugin contracts, anti-patterns

$ARGUMENTS
