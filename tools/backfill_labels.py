#!/usr/bin/env python3
"""Backfill `size:*` and `priority:*` labels across the Roxabi org.

Sources current values from `~/.roxabi/corpus.db` (ProjectV2 fields + existing
labels) and proposes `gh` commands to converge on the dev-core canonical
label vocabulary:

    size:S | size:F-lite | size:F-full       (matches dev-core dev-tier)
    priority:P0 | P1 | P2 | P3
    graph:lane/X                              (already in place)

Default mode: dry-run — prints the `gh` commands without executing.
Pass `--apply` to execute. Pass `--repo <owner/name>` to scope to one repo.

Note: labels must exist in each repo before they can be applied. The script
emits `gh label create … --force` for every label it intends to use.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

DB_PATH = Path(os.environ.get("CORPUS_DB_PATH", Path.home() / ".roxabi/corpus.db"))

# Mapping: ProjectV2 priority field value -> label suffix
PRIORITY_FROM_PROJECT = {
    "P1 - High": "P1",
    "P2 - Medium": "P2",
    "P3 - Low": "P3",
}

# Mapping: ProjectV2 size field value -> canonical size label
# Per dev-core LEGACY_LABEL_MAP: M→F-lite, L→F-full, XL→F-full
SIZE_FROM_PROJECT = {
    "XS": "S",
    "S": "S",
    "M": "F-lite",
    "L": "F-full",
    "XL": "F-full",
}

# Legacy priority labels -> canonical P-codes
PRIORITY_LABEL_REMAP = {
    "priority:high": "priority:P1",
    "priority:medium": "priority:P2",
    "priority:low": "priority:P3",
    "priority: low": "priority:P3",  # typo fix
}

# Legacy size labels -> canonical (only `size:M` drift; F-lite/F-full already correct)
SIZE_LABEL_REMAP = {
    "size:M": "size:F-lite",
}

# Color hints for label creation (hex without #)
LABEL_COLORS = {
    "size:S": "bfd4f2",
    "size:F-lite": "fbca04",
    "size:F-full": "d93f0b",
    "priority:P0": "b60205",
    "priority:P1": "d93f0b",
    "priority:P2": "fbca04",
    "priority:P3": "c2e0c6",
}

CANONICAL_SIZE_LABELS = {f"size:{v}" for v in {"S", "F-lite", "F-full"}}
CANONICAL_PRIORITY_LABELS = {f"priority:{v}" for v in {"P0", "P1", "P2", "P3"}}


def fetch_state(conn: sqlite3.Connection) -> dict[str, dict]:
    """Return {issue_key: {repo, size, priority, labels:set[str]}} for open issues."""
    state: dict[str, dict] = {}
    for row in conn.execute(
        "SELECT key, repo, size, priority FROM issues WHERE state='open'"
    ):
        state[row[0]] = {
            "repo": row[1],
            "size": row[2],
            "priority": row[3],
            "labels": set(),
        }
    for row in conn.execute(
        "SELECT issue_key, name FROM labels WHERE issue_key IN "
        "(SELECT key FROM issues WHERE state='open')"
    ):
        if row[0] in state:
            state[row[0]]["labels"].add(row[1])
    return state


def plan_for_issue(info: dict) -> tuple[set[str], set[str]]:
    """Compute (add, remove) label sets for one issue."""
    add: set[str] = set()
    remove: set[str] = set()
    labels = info["labels"]

    # 1. Remap legacy priority labels -> P-codes
    for old, new in PRIORITY_LABEL_REMAP.items():
        if old in labels:
            remove.add(old)
            add.add(new)

    # 2. Remap drift size labels -> canonical
    for old, new in SIZE_LABEL_REMAP.items():
        if old in labels:
            remove.add(old)
            add.add(new)

    effective = (labels - remove) | add

    # 3. Backfill size from ProjectV2 if no canonical size:* present
    has_size = any(lbl in CANONICAL_SIZE_LABELS for lbl in effective)
    if info["size"] and not has_size:
        mapped = SIZE_FROM_PROJECT.get(info["size"])
        if mapped:
            add.add(f"size:{mapped}")

    # 4. Backfill priority from ProjectV2 if no canonical priority:* present
    has_priority = any(lbl in CANONICAL_PRIORITY_LABELS for lbl in effective)
    if info["priority"] and not has_priority:
        mapped = PRIORITY_FROM_PROJECT.get(info["priority"])
        if mapped:
            add.add(f"priority:{mapped}")

    return add, remove


def gh(cmd: list[str], apply: bool) -> int:
    if not apply:
        print("  $", " ".join(cmd))
        return 0
    result = subprocess.run(cmd, check=False)
    return result.returncode


def ensure_labels_exist(repos_with_labels: dict[str, set[str]], apply: bool) -> None:
    print("\n# Step 1: ensure labels exist in each repo")
    for repo in sorted(repos_with_labels):
        for label in sorted(repos_with_labels[repo]):
            color = LABEL_COLORS.get(label, "ededed")
            gh(
                ["gh", "label", "create", label, "--repo", repo, "--color", color, "--force"],
                apply,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="execute gh commands")
    parser.add_argument("--repo", help="scope to one repo (e.g. Roxabi/lyra)")
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"corpus DB not found at {DB_PATH}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    state = fetch_state(conn)

    repos_with_labels: dict[str, set[str]] = defaultdict(set)
    plans: list[tuple[str, dict, set[str], set[str]]] = []
    for key, info in state.items():
        if args.repo and info["repo"] != args.repo:
            continue
        add, remove = plan_for_issue(info)
        if not add and not remove:
            continue
        plans.append((key, info, add, remove))
        for lbl in add:
            repos_with_labels[info["repo"]].add(lbl)

    print(f"# {len(plans)} issues need changes (mode: {'APPLY' if args.apply else 'DRY-RUN'})")
    ensure_labels_exist(repos_with_labels, args.apply)

    print("\n# Step 2: per-issue label edits")
    for key, info, add, remove in plans:
        repo, num = key.split("#")
        cmd = ["gh", "issue", "edit", num, "--repo", repo]
        for lbl in sorted(add):
            cmd += ["--add-label", lbl]
        for lbl in sorted(remove):
            cmd += ["--remove-label", lbl]
        print(f"\n## {key}  +{sorted(add)}  -{sorted(remove)}")
        gh(cmd, args.apply)

    return 0


if __name__ == "__main__":
    sys.exit(main())
