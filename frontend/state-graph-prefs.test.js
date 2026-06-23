import { beforeEach, describe, expect, it, vi } from "vitest";

describe("graph order-by preference", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("defaults graphCol to none when nothing is stored", async () => {
    const { state } = await import("./state.js");
    expect(state.graphCol).toBe("none");
  });

  it("reads graphCol from localStorage", async () => {
    localStorage.setItem("v6:graphCol", "repo");
    const { state } = await import("./state.js");
    expect(state.graphCol).toBe("repo");
  });

  it("migrates legacy sessionStorage graphCol into localStorage", async () => {
    sessionStorage.setItem("v6:graphCol", "lane");
    const { state } = await import("./state.js");
    expect(state.graphCol).toBe("lane");
    expect(localStorage.getItem("v6:graphCol")).toBe("lane");
  });

  it("persists graphCol changes to localStorage via setState", async () => {
    const { setState, state } = await import("./state.js");
    setState({ graphCol: "priority" });
    expect(state.graphCol).toBe("priority");
    expect(localStorage.getItem("v6:graphCol")).toBe("priority");
    expect(sessionStorage.getItem("v6:graphCol")).toBeNull();
  });
});
