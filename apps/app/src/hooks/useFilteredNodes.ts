/**
 * useFilteredNodes — apply the dashboard filter facets to an annotated node set.
 * Pure client-side (the corpus is small and already in memory); recomputes only
 * when the nodes or any facet changes.
 */

import { useDashboardStore } from "@/store/dashboardStore";
import {
  type AnnotatedNode,
  type GraphEdge,
  type NodeFilters,
  filterNodes,
} from "@roxabi-live/shared";
import { useMemo } from "react";

export function useFilteredNodes(nodes: AnnotatedNode[], edges: GraphEdge[]): AnnotatedNode[] {
  const repo = useDashboardStore((s) => s.repo);
  const milestone = useDashboardStore((s) => s.milestone);
  const priority = useDashboardStore((s) => s.priority);
  const assignee = useDashboardStore((s) => s.assignee);
  const status = useDashboardStore((s) => s.status);
  const label = useDashboardStore((s) => s.label);
  const search = useDashboardStore((s) => s.search);
  const showParents = useDashboardStore((s) => s.showParents);

  return useMemo(() => {
    const filters: NodeFilters = {
      repo,
      milestone,
      priority,
      assignee,
      status,
      label,
      search,
      showParents,
    };
    return filterNodes(nodes, edges, filters);
  }, [nodes, edges, repo, milestone, priority, assignee, status, label, search, showParents]);
}
