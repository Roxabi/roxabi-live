# E2E dev_state Sampling Procedure (#82 SC-6)

Manual verification of the falsifiability check from the frame:
> Sample 10 active issues, count correctly-animated ones, abort if <8/10.

## Procedure

1. Run the server with a fresh reconciler heal:
   ```bash
   cd /home/mickael/projects/roxabi-live
   uv run roxabi-live &
   # wait ~30s for sync + heal to populate has_active_branch + pr_state
   ```

2. Pull open issues with active branches from corpus:
   ```bash
   sqlite3 ~/.roxabi/corpus.db \
     "SELECT key FROM issues WHERE state='open' AND has_active_branch=1"
   ```

3. Pull non-idle nodes from API:
   ```bash
   curl -s http://localhost:8000/api/graph | \
     jq '.nodes[] | select(.dev_state != "idle") | {key, dev_state}'
   ```

4. Cross-reference: every key from step 2 should appear in step 3 as
   `dev_state ∈ {"dev","pr_open","pr_reviewed"}`. Allow ≤2 missing (≥8/10
   rule).

Bonus: pick PRs with `reviewed` label
```bash
sqlite3 ~/.roxabi/corpus.db \
  "SELECT closing_issue_keys FROM pr_state WHERE has_reviewed_label=1"
```
Each issue key should show `dev_state="pr_reviewed"` in the API output.

## Smoke test run — 2026-05-26

After Wave 4 fix (`e2b633a`):
- DB: 13 has_active_branch=1 (12 closed → idle, 1 open: `lyra#1373` → dev)
- DB: 49 pr_state rows, 1 reviewed (PR #1408 closes `lyra#1396`)
- API: 1 `dev`, 1 `pr_reviewed`, 1463 `idle` — matches expected
