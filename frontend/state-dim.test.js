import { describe, expect, it } from "vitest";
import { EMPTY_DIM, dimValue } from "./state.js";

describe("dimValue empty buckets", () => {
  it("normalizes missing milestone and priority to (None)", () => {
    const bare = {
      key: "Roxabi/demo#1",
      milestone: null,
      milestone_code: null,
      priority: null,
      lane: null,
      size: null,
      repo: "Roxabi/demo",
      _status: "ready",
      assignees: [],
    };
    expect(dimValue(bare, "milestone")).toBe(EMPTY_DIM);
    expect(dimValue(bare, "priority")).toBe(EMPTY_DIM);
    expect(dimValue(bare, "lane")).toBe(EMPTY_DIM);
  });
});
