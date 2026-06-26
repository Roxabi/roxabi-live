// Unit coverage for the dashboard regression fixes the Playwright /dev/table
// pass exercises in-browser, so CI (vitest) protects them too. Focus: the new
// closedUnderOpenEpic graph override branch in shared filterNodes (R1).

import {
  type GraphEdge,
  type GraphNode,
  type NodeFilters,
  annotateNodes,
  filterNodes,
} from "@roxabi-live/shared";
import { describe, expect, it } from "vitest";

function node(p: Partial<GraphNode> & { key: string }): GraphNode {
  const [repo, num] = p.key.split("#");
  return {
    repo,
    number: Number(num),
    title: null,
    state: "open",
    dev_state: "idle",
    url: null,
    milestone: null,
    milestone_code: null,
    milestone_name: null,
    milestone_sort_key: 9999,
    labels: [],
    priority: null,
    lane: null,
    size: null,
    status: null,
    is_stub: false,
    assignees: [],
    ...p,
  };
}

const baseFilters = (over: Partial<NodeFilters> = {}): NodeFilters => ({
  repo: [],
  milestone: [],
  priority: [],
  assignee: [],
  status: ["ready", "blocked"],
  label: [],
  search: "",
  showParents: true,
  ...over,
});

describe("filterNodes — closedUnderOpenEpic (R1)", () => {
  // Open epic #1, closed child #2 (done), open standalone #3 (ready).
  const nodes: GraphNode[] = [
    node({ key: "r/x#1", state: "open" }),
    node({ key: "r/x#2", state: "closed" }),
    node({ key: "r/x#3", state: "open" }),
  ];
  const edges: GraphEdge[] = [{ src: "r/x#1", dst: "r/x#2", kind: "parent" }];
  const annotated = annotateNodes(nodes, edges);

  it("hides a done child under an open epic when status excludes done", () => {
    const out = filterNodes(annotated, edges, baseFilters());
    expect(out.map((n) => n.key).sort()).toEqual(["r/x#1", "r/x#3"]);
  });

  it("keeps the done child when closedUnderOpenEpic is on", () => {
    const out = filterNodes(annotated, edges, baseFilters({ closedUnderOpenEpic: true }));
    expect(out.map((n) => n.key)).toContain("r/x#2");
  });

  it("does NOT keep a done child whose parent epic is itself closed", () => {
    const closedEpic = [
      node({ key: "r/x#1", state: "closed" }),
      node({ key: "r/x#2", state: "closed" }),
    ];
    const ann = annotateNodes(closedEpic, edges);
    const out = filterNodes(ann, edges, baseFilters({ closedUnderOpenEpic: true }));
    expect(out.map((n) => n.key)).not.toContain("r/x#2");
  });
});
