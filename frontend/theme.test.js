import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThemePref, resolveTheme, setThemePref } from "./theme.js";

describe("theme preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to auto when unset", () => {
    expect(getThemePref()).toBe("auto");
  });

  it("persists explicit preference", () => {
    setThemePref("dark");
    expect(getThemePref()).toBe("dark");
    setThemePref("light");
    expect(getThemePref()).toBe("light");
  });

  it("resolveTheme maps auto to system", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {} }));
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("auto")).toBe("dark");
    vi.restoreAllMocks();
  });
});
