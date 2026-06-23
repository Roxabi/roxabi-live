import { describe, expect, it } from "vitest";
import { getHighlightChain } from "./hover.js";

describe("highlight chain traversal", () => {
  const edges = [
    { src: "Org/a#1", dst: "Org/a#2", kind: "blocks" },
    { src: "Org/a#2", dst: "Org/a#3", kind: "blocks" },
    { src: "Org/a#10", dst: "Org/a#11", kind: "parent" },
  ];

  it("walks upstream and downstream along blocks edges only", () => {
    const chain = getHighlightChain("Org/a#2", edges);
    expect(chain.upstream.has("Org/a#1")).toBe(true);
    expect(chain.downstream.has("Org/a#3")).toBe(true);
    expect(chain.all.has("Org/a#2")).toBe(true);
    expect(chain.all.has("Org/a#10")).toBe(false);
    expect(chain.all.has("Org/a#11")).toBe(false);
  });

  it("traverses parent edges when the caller includes them in chainEdges", () => {
    const parentEdges = edges.filter((e) => e.kind === "parent");
    const chain = getHighlightChain("Org/a#10", parentEdges);
    expect(chain.downstream.has("Org/a#11")).toBe(true);
    expect(chain.upstream.size).toBe(0);
  });
});
