import { IssueTable } from "@/components/IssueTable";
import { annotateNodes } from "@roxabi-live/shared";
import { useMemo } from "react";
import { fixtureGraph } from "./fixture";

/**
 * DEV-only route (/dev/table) that renders IssueTable from a fixture corpus, so
 * the data pipeline + status colours can be browser-verified without an
 * authenticated session. Not registered in production builds.
 */
export default function DevTablePage() {
  const nodes = useMemo(() => annotateNodes(fixtureGraph.nodes, fixtureGraph.edges), []);
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-foreground">Launch Board — fixture</h1>
        <span className="text-sm text-muted-foreground">{nodes.length} issues (dev fixture)</span>
      </div>
      <IssueTable nodes={nodes} />
    </div>
  );
}
