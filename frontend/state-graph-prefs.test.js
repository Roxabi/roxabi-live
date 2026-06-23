import { beforeEach, describe, expect, it } from "vitest";
import { setState, state } from "./state.js";

describe("graph order-by preference", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("defaults graphCol to none when nothing is stored", async () => {
    const mod = await import(`./state.js?${Date.now()}`);
    expect(mod.state.graphCol).toBe("none");
  });

  it("reads graphCol from localStorage", async () => {
    localStorage.setItem("v6:graphCol", "repo");
    const mod = await import(`./state.js?${Date.now()}`);
    expect(mod.state.graphCol).toBe("repo");
  });

  it("migrates legacy sessionStorage graphCol into localStorage", async () => {
    sessionStorage.setItem("v6:graphCol", "lane");
    const mod = await import(`./state.js?${Date.now()}`);
    expect(mod.state.graphCol).toBe("lane");
    expect(localStorage.getItem("v6:graphCol")).toBe("lane");
  });

  it("persists graphCol changes to localStorage via setState", () => {
    setState({ graphCol: "priority" });
    expect(state.graphCol).toBe("priority");
    expect(localStorage.getItem("v6:graphCol")).toBe("priority");
    expect(sessionStorage.getItem("v6:graphCol")).toBeNull();
  });
});
