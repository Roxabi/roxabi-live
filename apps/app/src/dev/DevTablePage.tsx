import { FilterBar } from "@/components/FilterBar";
import { IssueTable } from "@/components/IssueTable";
import { useFilteredNodes } from "@/hooks/useFilteredNodes";
import { annotateNodes } from "@roxabi-live/shared";
import { useMemo } from "react";
import { fixtureGraph } from "./fixture";

/**
 * DEV-only route (/dev/table) that renders the filtered Launch Board from a
 * fixture corpus, so the data pipeline + filters + status colours can be
 * browser-verified without an authenticated session. Not in production builds.
 */
export default function DevTablePage() {
  const nodes = useMemo(() => annotateNodes(fixtureGraph.nodes, fixtureGraph.edges), []);
  const filtered = useFilteredNodes(nodes, fixtureGraph.edges);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-foreground">Launch Board — fixture</h1>
        <span className="text-sm text-muted-foreground">
          {filtered.length} of {nodes.length} issues (dev fixture)
        </span>
      </div>
      <FilterBar nodes={nodes} />
      <IssueTable nodes={filtered} />
    </div>
  );
}
