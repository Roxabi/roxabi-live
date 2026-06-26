import { BoardView } from "@/components/BoardView";
import { ViewToggle } from "@/components/ViewToggle";
import { annotateNodes } from "@roxabi-live/shared";
import { useMemo } from "react";
import { fixtureGraph } from "./fixture";

/**
 * DEV-only route (/dev/table) that renders the full BoardView (list / pivot /
 * graph toggle + filters) from a fixture corpus, so the data pipeline can be
 * browser-verified without an authenticated session. Not in production builds.
 */
export default function DevTablePage() {
  const nodes = useMemo(() => annotateNodes(fixtureGraph.nodes, fixtureGraph.edges), []);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-foreground">Launch Board — fixture</h1>
        <ViewToggle />
      </div>
      <BoardView nodes={nodes} edges={fixtureGraph.edges} repos={fixtureGraph.repos} />
    </div>
  );
}
