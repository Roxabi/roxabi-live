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
  type RepoSummary,
  filterNodes,
} from "@roxabi-live/shared";
import { useMemo } from "react";

export function useFilteredNodes(
  nodes: AnnotatedNode[],
  edges: GraphEdge[],
  repos: RepoSummary[] = [],
): AnnotatedNode[] {
  const repo = useDashboardStore((s) => s.repo);
  const milestone = useDashboardStore((s) => s.milestone);
  const priority = useDashboardStore((s) => s.priority);
  const assignee = useDashboardStore((s) => s.assignee);
  const status = useDashboardStore((s) => s.status);
  const label = useDashboardStore((s) => s.label);
  const search = useDashboardStore((s) => s.search);
  const showParents = useDashboardStore((s) => s.showParents);
  const view = useDashboardStore((s) => s.view);
  const showClosedUnderOpenEpic = useDashboardStore((s) => s.showClosedUnderOpenEpic);

  // The "Closed under open epic" override is a graph-only concern (legacy
  // filteredNodesForGraph). In list/pivot the status facet stays strict.
  const closedUnderOpenEpic = view === "graph" && showClosedUnderOpenEpic;

  const archivedRepos = useMemo(
    () => new Set(repos.filter((r) => r.archived).map((r) => r.repo)),
    [repos],
  );

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
      closedUnderOpenEpic,
      archivedRepos: archivedRepos.size > 0 ? archivedRepos : undefined,
    };
    return filterNodes(nodes, edges, filters);
  }, [
    nodes,
    edges,
    archivedRepos,
    repo,
    milestone,
    priority,
    assignee,
    status,
    label,
    search,
    showParents,
    closedUnderOpenEpic,
  ]);
}
