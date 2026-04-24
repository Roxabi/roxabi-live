"""v6 layout config — milestones + column groups.

Project-agnostic: callers pass a ``LayoutConfig`` (or load one from JSON).
No lyra-specific defaults baked in.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Milestone:
    code: str
    title: str


@dataclass(frozen=True)
class ColumnGroup:
    code: str
    title: str
    lanes: tuple[str, ...] = ()


@dataclass(frozen=True)
class LayoutConfig:
    milestones: tuple[Milestone, ...] = field(default_factory=tuple)
    column_groups: tuple[ColumnGroup, ...] = field(default_factory=tuple)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LayoutConfig:
        milestones_raw: list[dict[str, Any]] = data.get("milestones", [])
        groups_raw: list[dict[str, Any]] = data.get("column_groups", [])
        ms = tuple(Milestone(code=m["code"], title=m["title"]) for m in milestones_raw)
        cg = tuple(
            ColumnGroup(
                code=c["code"],
                title=c["title"],
                lanes=tuple(c.get("lanes", ())),
            )
            for c in groups_raw
        )
        return cls(milestones=ms, column_groups=cg)

    @classmethod
    def from_json(cls, path: Path) -> LayoutConfig:
        return cls.from_dict(json.loads(path.read_text()))
