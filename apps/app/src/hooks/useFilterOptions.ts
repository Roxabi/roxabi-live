/**
 * useFilterOptions — derive the selectable options (value + display label +
 * count) for every filter facet from the *unfiltered* annotated node set, so
 * the option lists and their counts stay stable as the user filters.
 */

import type { FacetKey } from "@/store/dashboardStore";
import {
  type AnnotatedNode,
  EMPTY_ASSIGNEE,
  EMPTY_DIM,
  type StatusKey,
  displayStatus,
} from "@roxabi-live/shared";
import { useMemo } from "react";

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

export type FilterOptions = Record<FacetKey, FilterOption[]>;

const STATUS_ORDER: StatusKey[] = ["ready", "running", "blocked", "done"];
const STATUS_LABEL: Record<StatusKey, string> = {
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  done: "Done",
};
const PRIORITY_ORDER = ["P0", "P1", "P2", "P3", EMPTY_DIM];

// Structured/metadata labels conveyed by dedicated facets (size, priority, lane)
// are hidden from the Label facet so it only lists meaningful free-form labels.
// Ported verbatim from frontend/app.js LABEL_EXCLUDES + isStructuredLabel.
const LABEL_EXCLUDES = new Set([
  "graph:lane/",
  "size:",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "P0",
  "priority:P0",
  "P1-high",
  "priority:high",
  "priority:P1",
  "P2-medium",
  "priority:medium",
  "priority:P2",
  "P3-low",
  "priority:low",
  "priority: low",
  "priority:P3",
]);

function isStructuredLabel(lbl: string): boolean {
  if (LABEL_EXCLUDES.has(lbl)) return true;
  return lbl.startsWith("graph:lane/") || lbl.startsWith("size:");
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function useFilterOptions(nodes: AnnotatedNode[]): FilterOptions {
  return useMemo(() => {
    const repo = new Map<string, number>();
    const milestone = new Map<string, number>();
    const priority = new Map<string, number>();
    const assignee = new Map<string, number>();
    const status = new Map<string, number>();
    const label = new Map<string, number>();
    const msMeta = new Map<string, { name: string | null; sortKey: number }>();

    for (const n of nodes) {
      bump(repo, n.repo);
      const ms = n.milestone_code ?? EMPTY_DIM;
      bump(milestone, ms);
      if (!msMeta.has(ms)) {
        msMeta.set(ms, {
          name: n.milestone_name,
          sortKey: ms === EMPTY_DIM ? 99999 : n.milestone_sort_key,
        });
      }
      bump(priority, n.priority ?? EMPTY_DIM);
      bump(status, displayStatus(n));
      for (const l of n.labels) if (!isStructuredLabel(l)) bump(label, l);
      if (n.assignees.length) {
        for (const a of n.assignees) bump(assignee, a);
      } else {
        bump(assignee, EMPTY_ASSIGNEE);
      }
    }

    const opt = (value: string, lbl: string, count: number): FilterOption => ({
      value,
      label: lbl,
      count,
    });

    return {
      status: STATUS_ORDER.filter((s) => status.has(s)).map((s) =>
        opt(s, STATUS_LABEL[s], status.get(s) ?? 0),
      ),
      repo: [...repo]
        .map(([v, c]) => opt(v, v.replace(/^[^/]+\//, ""), c))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      milestone: [...milestone]
        .map(([v, c]) => opt(v, v === EMPTY_DIM ? "No milestone" : (msMeta.get(v)?.name ?? v), c))
        .sort(
          (a, b) =>
            (msMeta.get(a.value)?.sortKey ?? 99999) - (msMeta.get(b.value)?.sortKey ?? 99999) ||
            a.label.localeCompare(b.label),
        ),
      priority: [...priority]
        .map(([v, c]) => opt(v, v === EMPTY_DIM ? "No priority" : v, c))
        .sort((a, b) => PRIORITY_ORDER.indexOf(a.value) - PRIORITY_ORDER.indexOf(b.value)),
      label: [...label]
        .map(([v, c]) => opt(v, v, c))
        .sort((a, b) => a.label.localeCompare(b.label)),
      assignee: [...assignee]
        .map(([v, c]) => opt(v, v === EMPTY_ASSIGNEE ? "Unassigned" : v, c))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    };
  }, [nodes]);
}
