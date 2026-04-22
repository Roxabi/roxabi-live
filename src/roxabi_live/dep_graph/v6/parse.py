"""v6 parse helpers — milestone, priority, lane, size derivation."""

from __future__ import annotations

import re

_MILESTONE_MN = re.compile(r"^M(\d+)\s*[—–-]\s*(.+)$")
_MILESTONE_PHASE = re.compile(r"^Phase\s+(\d+)\s*[—–-]\s*(.+)$")
_SIZE_LABELS = {"XS", "S", "M", "L", "XL"}
_LANE_PREFIX = "graph:lane/"
_SIZE_PREFIX = "size:"


def parse_milestone(
    raw: str | None,
) -> tuple[str | None, str | None, int]:
    """Parse a raw milestone string into (code, name, sort_key).

    Formats handled:
    - ``M0 — NATS hardening``  → (``M0``, ``NATS hardening``, 0)
    - ``M10 — Social Media``   → (``M10``, ``Social Media``, 10)
    - ``Phase 0 — Foundation`` → (``Ph0``, ``Foundation``, 100)
    - ``Phase 5 — Security``   → (``Ph5``, ``Security``, 105)
    - ``Final Initiatives``    → (``FIN``, ``Final Initiatives``, 999)
    - ``None``                 → (``None``, ``None``, 1000)
    - unknown text             → (``None``, raw, 1000)
    """
    if raw is None:
        return None, None, 1000

    m = _MILESTONE_MN.match(raw)
    if m:
        n = int(m.group(1))
        return f"M{n}", m.group(2).strip(), n

    m = _MILESTONE_PHASE.match(raw)
    if m:
        n = int(m.group(1))
        return f"Ph{n}", m.group(2).strip(), 100 + n

    if raw.strip() == "Final Initiatives":
        return "FIN", "Final Initiatives", 999

    return None, raw, 1000


def derive_priority(labels: list[str]) -> str | None:
    """Return normalized priority string from label list; first match wins.

    Mapping:
    - ``P0``                              → ``P0``
    - ``P1-high`` | ``priority:high``     → ``P1``
    - ``P2-medium`` | ``priority:medium`` → ``P2``
    - ``P3-low`` | ``priority:low``
      | ``priority: low``                 → ``P3``
    """
    for label in labels:
        if label == "P0":
            return "P0"
        if label in ("P1-high", "priority:high"):
            return "P1"
        if label in ("P2-medium", "priority:medium"):
            return "P2"
        if label in ("P3-low", "priority:low", "priority: low"):
            return "P3"
    return None


def derive_lane_size(labels: list[str]) -> tuple[str | None, str | None]:
    """Return (lane, size) derived from label list.

    Lane: first label starting with ``graph:lane/`` → strip prefix.
    Size: first label starting with ``size:`` → strip prefix;
          fallback to raw XS/S/M/L/XL label.
    """
    lane: str | None = None
    size: str | None = None

    for lbl in labels:
        if lane is None and lbl.startswith(_LANE_PREFIX):
            lane = lbl[len(_LANE_PREFIX):]
        if size is None and lbl.startswith(_SIZE_PREFIX):
            size = lbl[len(_SIZE_PREFIX):]
        if lane is not None and size is not None:
            break

    if size is None:
        for lbl in labels:
            if lbl in _SIZE_LABELS:
                size = lbl
                break

    return lane, size
