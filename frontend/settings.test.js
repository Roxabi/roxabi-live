import { beforeEach, describe, expect, it } from "vitest";
import { getDisplayName, setDisplayName } from "./settings.js";

describe("display name", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to github login", () => {
    expect(getDisplayName("alice")).toBe("alice");
  });

  it("stores and retrieves custom display name", () => {
    setDisplayName("alice", "Alice B.");
    expect(getDisplayName("alice")).toBe("Alice B.");
  });

  it("clears custom name when set to login", () => {
    setDisplayName("alice", "Alice");
    setDisplayName("alice", "alice");
    expect(getDisplayName("alice")).toBe("alice");
  });
});
