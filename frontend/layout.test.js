import { describe, expect, it } from "vitest";
import { layoutV5 } from "./layout.js";
import { EMPTY_DIM, compareDimValues } from "./state.js";

function node(key, opts = {}) {
  return {
    key,
    repo: "Roxabi/demo",
    number: Number.parseInt(key.split("#")[1], 10),
    milestone: "milestoneRaw" in opts ? opts.milestoneRaw : "M1",
    milestone_code: "milestoneCode" in opts ? opts.milestoneCode : "M1",
    milestone_name: opts.milestoneName ?? null,
    milestone_sort_key: opts.milestoneSortKey ?? 1,
    priority: "priorityRaw" in opts ? opts.priorityRaw : "P1",
    lane: "laneRaw" in opts ? opts.laneRaw : "dev",
    size: null,
    state: "open",
    _status: "ready",
    assignees: [],
    labels: [],
  };
}

describe("compareDimValues", () => {
  it("sorts empty buckets before populated values", () => {
    expect(compareDimValues(EMPTY_DIM, "M1", "milestone")).toBeLessThan(0);
    expect(compareDimValues(EMPTY_DIM, "P0", "priority")).toBeLessThan(0);
  });
});

describe("layoutV5 column grouping", () => {
  it("maps priority columns to distinct X positions", () => {
    const nodes = [
      node("Roxabi/demo#1", { priorityRaw: "P0" }),
      node("Roxabi/demo#2", { priorityRaw: "P1" }),
    ];
    const result = layoutV5(nodes, [], "milestone", "priority");
    const x0 = result.positions.get("Roxabi/demo#1")?.x;
    const x1 = result.positions.get("Roxabi/demo#2")?.x;
    expect(x0).toBeDefined();
    expect(x1).toBeDefined();
    expect(x0).toBeLessThan(x1);
    expect(result.colInfo.map((c) => c.code)).toEqual(["P0", "P1"]);
  });

  it("places the no-priority column first", () => {
    const nodes = [
      node("Roxabi/demo#1", { priorityRaw: null }),
      node("Roxabi/demo#2", { priorityRaw: "P0" }),
    ];
    const result = layoutV5(nodes, [], "milestone", "priority");
    expect(result.colInfo[0]?.code).toBe(EMPTY_DIM);
    expect(result.colInfo[0]?.label).toBe("No priority");
    const xNone = result.positions.get("Roxabi/demo#1")?.x;
    const xP0 = result.positions.get("Roxabi/demo#2")?.x;
    expect(xNone).toBeLessThan(xP0);
  });

  it("places the no-milestone row first", () => {
    const nodes = [
      node("Roxabi/demo#1", { milestoneCode: null, milestoneRaw: null, milestoneSortKey: 9999 }),
      node("Roxabi/demo#2", { milestoneCode: "M1", milestoneSortKey: 1 }),
    ];
    const result = layoutV5(nodes, [], "milestone", "priority");
    expect(result.rowInfo[0]?.code).toBe(EMPTY_DIM);
    expect(result.rowInfo[0]?.label).toBe("No milestone");
  });

  it("keeps same-column nodes aligned on X across depth bands", () => {
    const nodes = [
      node("Roxabi/demo#1", { priorityRaw: "P0" }),
      node("Roxabi/demo#2", { priorityRaw: "P0" }),
    ];
    const edges = [{ src: "Roxabi/demo#1", dst: "Roxabi/demo#2", kind: "blocks" }];
    const result = layoutV5(nodes, edges, "milestone", "priority");
    const x0 = result.positions.get("Roxabi/demo#1")?.x;
    const x1 = result.positions.get("Roxabi/demo#2")?.x;
    expect(x0).toBeDefined();
    expect(x1).toBeDefined();
    expect(Math.abs(x0 - x1)).toBeLessThan(12);
  });
});
