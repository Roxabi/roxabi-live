"""v6 CLI — dev utility to dump graph JSON to stdout.

Production path is the HTTP API (``GET /api/graph``); this CLI is for
local debugging only.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from .api import build_graph_json


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dep-graph-v6")
    parser.add_argument(
        "--db",
        type=Path,
        default=Path(
            os.environ.get("CORPUS_DB_PATH", Path.home() / ".roxabi" / "corpus.db")
        ),
    )
    args = parser.parse_args(argv)
    payload = asyncio.run(build_graph_json(args.db))
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
