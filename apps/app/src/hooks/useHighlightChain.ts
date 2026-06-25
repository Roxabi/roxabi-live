/**
 * useHighlightChain — memoised dependency-chain for the hovered graph node.
 * Returns null when nothing is hovered (the graph renders everything at full
 * opacity); otherwise the upstream + downstream + self set.
 */

import { type GraphEdge, type HighlightChain, getHighlightChain } from "@roxabi-live/shared";
import { useMemo } from "react";

export function useHighlightChain(
  hovered: string | null,
  edges: GraphEdge[],
): HighlightChain | null {
  return useMemo(() => (hovered ? getHighlightChain(hovered, edges) : null), [hovered, edges]);
}
