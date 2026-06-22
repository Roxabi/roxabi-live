import { describe, expect, it } from "vitest";
import { layoutV5 } from "./layout.js";
import { EMPTY_DIM, compareDimValues } from "./state.js";

function node(key, opts = {}) {
  return {
    key,
    repo: opts.repo ?? "Roxabi/demo",
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

  it("spreads nodes horizontally when col is none", () => {
    const nodes = [node("Roxabi/demo#1"), node("Roxabi/demo#2"), node("Roxabi/demo#3")];
    const result = layoutV5(nodes, [], "milestone", "none");
    const xs = [...result.positions.values()].map((p) => p.x);
    expect(new Set(xs).size).toBeGreaterThan(1);
    expect(result.colInfo).toEqual([]);
  });

  it("clamps node X so labels do not bleed into the row gutter", () => {
    const nodes = [node("Roxabi/demo#1", { priorityRaw: "P0" })];
    const result = layoutV5(nodes, [], "milestone", "priority");
    expect(result.positions.get("Roxabi/demo#1")?.x).toBeGreaterThanOrEqual(8);
  });

  it("keeps node X positions inside the visible lane span", () => {
    const nodes = Array.from({ length: 24 }, (_, i) =>
      node(`Roxabi/repo-${i}#1`, { repo: `Org/repo-${i}` }),
    );
    const result = layoutV5(nodes, [], "milestone", "repo");
    for (const pos of result.positions.values()) {
      expect(pos.x).toBeGreaterThanOrEqual(3.5);
      expect(pos.x).toBeLessThanOrEqual(96.5);
    }
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

  it("keeps readable spacing when many filtered children share a parent column", () => {
    const epics = Array.from({ length: 8 }, (_, i) =>
      node(`Roxabi/demo#${i + 1}`, { milestoneCode: null, milestoneRaw: null, priorityRaw: null }),
    );
    const subs = Array.from({ length: 24 }, (_, i) =>
      node(`Roxabi/demo#${i + 9}`, { milestoneCode: null, milestoneRaw: null, priorityRaw: null }),
    );
    const edges = subs.map((s, i) => ({ src: epics[i % 8].key, dst: s.key, kind: "parent" }));
    const result = layoutV5([...epics, ...subs], edges, "milestone", "priority");
    const byBand = new Map();
    for (const [, pos] of result.positions) {
      const band = pos.y.toFixed(4);
      if (!byBand.has(band)) byBand.set(band, []);
      byBand.get(band).push(pos.x);
    }
    const bands = [...byBand.entries()].sort(
      (a, b) => Number.parseFloat(a[0]) - Number.parseFloat(b[0]),
    );
    const second = bands[1]?.[1].sort((a, b) => a - b) ?? [];
    const gaps = second.slice(1).map((x, i) => x - second[i]);
    const minGap = gaps.length ? Math.min(...gaps) : 99;
    expect(minGap).toBeGreaterThanOrEqual(3);
    for (const [, band] of byBand) {
      const xs = band.map((x) => x.toFixed(2));
      expect(new Set(xs).size).toBe(xs.length);
    }
  });

  it("orders by repo even when parent edges align children under epics", () => {
    const epic = node("Roxabi/live#1", {
      repo: "Roxabi/live",
      milestoneCode: null,
      milestoneRaw: null,
    });
    const childA = node("Roxabi/live#2", {
      repo: "Roxabi/live",
      milestoneCode: null,
      milestoneRaw: null,
    });
    const childB = node("Roxabi/factory#3", {
      repo: "Roxabi/factory",
      milestoneCode: null,
      milestoneRaw: null,
    });
    const edges = [
      { src: epic.key, dst: childA.key, kind: "parent" },
      { src: epic.key, dst: childB.key, kind: "parent" },
    ];
    const result = layoutV5([epic, childA, childB], edges, "milestone", "repo");
    const xLive = result.positions.get(childA.key)?.x;
    const xFactory = result.positions.get(childB.key)?.x;
    expect(xLive).toBeDefined();
    expect(xFactory).toBeDefined();
    expect(result.colInfo.map((c) => c.code)).toEqual(["Roxabi/factory", "Roxabi/live"]);
    expect(xFactory).toBeLessThan(xLive);
    expect(result.positions.get(epic.key)?.x).toBeCloseTo(xLive, 0);
  });

  it("does not stack same-repo nodes on the second milestone row", () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
      node(`Org/repo-${i % 3}#${i + 1}`, {
        repo: `Org/repo-${i % 3}`,
        milestoneCode: i < 5 ? "M1" : "M2",
        milestoneSortKey: i < 5 ? 1 : 2,
      }),
    );
    const result = layoutV5(nodes, [], "milestone", "repo");
    const byBand = new Map();
    for (const [key, pos] of result.positions) {
      const band = pos.y.toFixed(4);
      if (!byBand.has(band)) byBand.set(band, []);
      byBand.get(band).push({ key, x: pos.x });
    }
    for (const [, band] of byBand) {
      const xs = band.map((b) => b.x.toFixed(2));
      expect(new Set(xs).size).toBe(xs.length);
    }
  });
});
