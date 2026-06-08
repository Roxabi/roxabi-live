"""Corpus CLI — unified entry point.

Subcommands:
  init    Initialise the corpus DB (idempotent).
  sync    Sync issues from GitHub (V2).
  stats   Print row counts from the corpus DB.

Common flags:
  --db PATH   (default: ~/.roxabi/corpus.db)
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from roxabi_live.corpus import schema, sync
from roxabi_live.corpus.graphql import GraphQLError

DEFAULT_DB = Path.home() / ".roxabi" / "corpus.db"


def cmd_init(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    schema.bootstrap(db_path)
    print(f"Initialised {db_path}")
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    schema.bootstrap(db_path)
    conn = schema.connect(db_path)
    try:
        if args.repo is not None:
            if not re.match(r"^[\w.-]+/[\w.-]+$", args.repo):
                print(
                    f"ERROR: --repo must be OWNER/NAME, got: {args.repo!r}",
                    file=sys.stderr,
                )
                return 1
            owner, name = args.repo.split("/", 1)
            row = conn.execute(
                "SELECT last_synced_at FROM sync_state WHERE repo = ?",
                (f"{owner}/{name}",),
            ).fetchone()
            since = None if args.full else (row[0] if row else None)
            counts = sync.run_repo_sync(conn, owner, name, since=since)
            print(
                f"Synced {counts['issues']} issues across {counts['pages']} pages"
                f" from {owner}/{name}"
            )
            return 0
        else:
            totals = sync.run_sync(conn, "Roxabi", full=args.full)
            print(
                f"Synced {totals['issues']} issues across {totals['pages']} pages"
                f" from {totals['repos']} repos;"
                f" {totals['stubs']} closed-hop stubs;"
                f" {totals['errors']} repo errors."
            )
            return 1 if totals["errors"] > 0 else 0
    except FileNotFoundError:
        print(
            "ERROR: gh CLI not found or not authenticated — run `gh auth login`",
            file=sys.stderr,
        )
        return 2
    except GraphQLError as e:
        print(f"ERROR: GraphQL failure: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


_REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")


def _validate_repo(repo: str) -> bool:
    return bool(_REPO_RE.match(repo))


def cmd_repo(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: {db_path} not found — run `init` first", file=sys.stderr)
        return 1
    conn = schema.connect(db_path)
    try:
        action = args.repo_action
        if action == "list":
            rows = conn.execute(
                "SELECT repo FROM repo_allowlist ORDER BY repo"
            ).fetchall()
            if rows:
                for (repo,) in rows:
                    print(repo)
            else:
                print("(empty)")
            return 0

        repo = args.repo_name
        if not _validate_repo(repo):
            print(
                f"ERROR: repo must be OWNER/NAME, got: {repo!r}",
                file=sys.stderr,
            )
            return 1

        if action == "add":
            cur = conn.execute(
                "INSERT OR IGNORE INTO repo_allowlist(repo) VALUES(?)", (repo,)
            )
            conn.commit()
            if cur.rowcount:
                print(f"added {repo}")
            else:
                print(f"already present {repo}")
            return 0

        if action == "remove":
            cur = conn.execute("DELETE FROM repo_allowlist WHERE repo = ?", (repo,))
            conn.commit()
            if cur.rowcount:
                print(f"removed {repo}")
            else:
                print(f"not in allowlist {repo}")
            return 0

    finally:
        conn.close()
    return 0  # unreachable — satisfies type checker


def cmd_stats(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: {db_path} not found — run `init` first", file=sys.stderr)
        return 1
    conn = schema.connect(db_path)
    try:
        issues = conn.execute("SELECT COUNT(*) FROM issues").fetchone()[0]
        labels = conn.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
        edges = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        repos = conn.execute("SELECT COUNT(*) FROM sync_state").fetchone()[0]
    finally:
        conn.close()
    print(f"issues={issues} labels={labels} edges={edges} repos={repos}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="corpus",
        description="Roxabi-org issue corpus sync.",
    )
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB),
        metavar="PATH",
        help="Path to corpus SQLite DB (default: %(default)s)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    p_init = subparsers.add_parser("init", help="Initialise the corpus DB (idempotent)")
    p_init.set_defaults(func=cmd_init)

    p_sync = subparsers.add_parser("sync", help="Sync issues from GitHub (V2)")
    p_sync.add_argument("--repo", default=None, metavar="OWNER/NAME")
    p_sync.add_argument(
        "--full", action="store_true", help="Full sync (ignore since cursor)"
    )
    p_sync.set_defaults(func=cmd_sync)

    p_stats = subparsers.add_parser("stats", help="Print row counts from the corpus DB")
    p_stats.set_defaults(func=cmd_stats)

    p_repo = subparsers.add_parser("repo", help="Manage repo allowlist")
    p_repo.set_defaults(func=cmd_repo)
    repo_sub = p_repo.add_subparsers(dest="repo_action", required=True)

    repo_sub.add_parser("list", help="List repos in allowlist")

    p_repo_add = repo_sub.add_parser("add", help="Add a repo to the allowlist")
    p_repo_add.add_argument("repo_name", metavar="OWNER/NAME")

    p_repo_remove = repo_sub.add_parser(
        "remove", help="Remove a repo from the allowlist"
    )
    p_repo_remove.add_argument("repo_name", metavar="OWNER/NAME")

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
