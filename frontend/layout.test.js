import { describe, expect, it } from "vitest";
import { layoutV5 } from "./layout.js";

function node(key, priority, milestone = "M1") {
  return {
    key,
    repo: "Roxabi/demo",
    number: Number.parseInt(key.split("#")[1], 10),
    milestone,
    milestone_code: milestone,
    milestone_name: null,
    milestone_sort_key: 1,
    priority,
    lane: "dev",
    size: null,
    state: "open",
    _status: "ready",
    assignees: [],
    labels: [],
  };
}

describe("layoutV5 column grouping", () => {
  it("maps priority columns to distinct X positions", () => {
    const nodes = [node("Roxabi/demo#1", "P0"), node("Roxabi/demo#2", "P1")];
    const result = layoutV5(nodes, [], "milestone", "priority");
    const x0 = result.positions.get("Roxabi/demo#1")?.x;
    const x1 = result.positions.get("Roxabi/demo#2")?.x;
    expect(x0).toBeDefined();
    expect(x1).toBeDefined();
    expect(x0).toBeLessThan(x1);
    expect(result.colInfo.map((c) => c.code)).toEqual(["P0", "P1"]);
  });

  it("keeps same-column nodes aligned on X across depth bands", () => {
    const nodes = [node("Roxabi/demo#1", "P0"), node("Roxabi/demo#2", "P0")];
    const edges = [{ src: "Roxabi/demo#1", dst: "Roxabi/demo#2", kind: "blocks" }];
    const result = layoutV5(nodes, edges, "milestone", "priority");
    const x0 = result.positions.get("Roxabi/demo#1")?.x;
    const x1 = result.positions.get("Roxabi/demo#2")?.x;
    expect(x0).toBeDefined();
    expect(x1).toBeDefined();
    expect(Math.abs(x0 - x1)).toBeLessThan(12);
  });
});
