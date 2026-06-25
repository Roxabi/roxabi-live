import { describe, expect, it } from "vitest";
import {
  computeGraphStatuses,
  filterNodesByStatus,
  parseClosedUnderOpenEpicQuery,
  parseStatusQuery,
} from "./status";

describe("parseStatusQuery", () => {
  it("returns null when param absent or empty", () => {
    expect(parseStatusQuery(null)).toBeNull();
    expect(parseStatusQuery("")).toBeNull();
    expect(parseStatusQuery("  ")).toBeNull();
  });

  it("parses comma-separated statuses", () => {
    const s = parseStatusQuery("ready, blocked");
    expect(s).toEqual(new Set(["ready", "blocked"]));
  });

  it("ignores invalid tokens", () => {
    expect(parseStatusQuery("ready,invalid")).toEqual(new Set(["ready"]));
  });
});

describe("parseClosedUnderOpenEpicQuery", () => {
  it("is false when absent or empty", () => {
    expect(parseClosedUnderOpenEpicQuery(null)).toBe(false);
    expect(parseClosedUnderOpenEpicQuery("")).toBe(false);
    expect(parseClosedUnderOpenEpicQuery("0")).toBe(false);
  });

  it("accepts truthy tokens", () => {
    expect(parseClosedUnderOpenEpicQuery("1")).toBe(true);
    expect(parseClosedUnderOpenEpicQuery("true")).toBe(true);
    expect(parseClosedUnderOpenEpicQuery("TRUE")).toBe(true);
  });
});

describe("computeGraphStatuses", () => {
  const nodes = [
    { key: "O/r#1", state: "open" },
    { key: "O/r#2", state: "open" },
    { key: "O/r#3", state: "closed" },
    { key: "O/r#4", state: "open" },
  ];

  it("marks blocked when open blocker exists", () => {
    const edges = [{ src: "O/r#1", dst: "O/r#2", kind: "blocks" }];
    const statuses = computeGraphStatuses(nodes.slice(0, 2), edges);
    expect(statuses.get("O/r#1")).toBe("ready");
    expect(statuses.get("O/r#2")).toBe("blocked");
  });

  it("propagates blocked through parent edges", () => {
    const edges = [
      { src: "O/r#1", dst: "O/r#2", kind: "blocks" },
      { src: "O/r#2", dst: "O/r#4", kind: "parent" },
    ];
    const statuses = computeGraphStatuses(
      nodes.filter((n) => n.key !== "O/r#3"),
      edges,
    );
    expect(statuses.get("O/r#4")).toBe("blocked");
  });

  it("closed nodes stay done under blocked parent", () => {
    const edges = [
      { src: "O/r#2", dst: "O/r#3", kind: "parent" },
      { src: "O/r#1", dst: "O/r#2", kind: "blocks" },
    ];
    const statuses = computeGraphStatuses(nodes, edges);
    expect(statuses.get("O/r#3")).toBe("done");
  });
});

describe("filterNodesByStatus", () => {
  const nodes = [
    { key: "O/r#1", state: "open" },
    { key: "O/r#2", state: "open" },
    { key: "O/r#3", state: "closed" },
  ];
  const edges = [{ src: "O/r#1", dst: "O/r#2", kind: "blocks" }];

  it("returns all nodes when filter is null", () => {
    expect(filterNodesByStatus(nodes, edges, null)).toHaveLength(3);
  });

  it("keeps only matching statuses", () => {
    const filtered = filterNodesByStatus(nodes, edges, new Set(["ready", "blocked"]));
    expect(filtered.map((n) => n.key).sort()).toEqual(["O/r#1", "O/r#2"]);
  });

  it("includes done children under open parent when closedUnderOpenEpic", () => {
    const allNodes = [
      { key: "O/r#1", state: "open" },
      { key: "O/r#2", state: "closed" },
      { key: "O/r#3", state: "closed" },
      { key: "O/r#4", state: "closed" },
    ];
    const parentEdges = [
      { src: "O/r#1", dst: "O/r#2", kind: "parent" },
      { src: "O/r#4", dst: "O/r#3", kind: "parent" },
    ];
    const filtered = filterNodesByStatus(allNodes, parentEdges, new Set(["ready", "blocked"]), {
      closedUnderOpenEpic: true,
    });
    expect(filtered.map((n) => n.key).sort()).toEqual(["O/r#1", "O/r#2"]);
  });
});
