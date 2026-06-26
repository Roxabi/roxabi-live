/**
 * useGraphData — fetch /api/graph and annotate the nodes.
 *
 * The raw {nodes, edges, repos} payload is cached by TanStack Query; the
 * annotated node array (computedStatus / parentKey / blockers) is derived in a
 * useMemo so it recomputes only when the payload changes. Server-side filters
 * (status[], closed_under_open_epic) join the queryKey in slice 3.
 */

import { apiFetch } from "@/lib/api";
import {
  type AnnotatedNode,
  type GraphEdge,
  type GraphResponse,
  type RepoSummary,
  annotateNodes,
} from "@roxabi-live/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export const GRAPH_QUERY_KEY = ["graph"] as const;

export function useGraphData() {
  const query = useQuery({
    queryKey: GRAPH_QUERY_KEY,
    queryFn: () => apiFetch<GraphResponse>("/api/graph"),
  });

  const nodes = useMemo<AnnotatedNode[]>(
    () => (query.data ? annotateNodes(query.data.nodes, query.data.edges) : []),
    [query.data],
  );

  return {
    ...query,
    nodes,
    edges: (query.data?.edges ?? []) as GraphEdge[],
    repos: (query.data?.repos ?? []) as RepoSummary[],
  };
}
