import { describe, it, expect } from "vitest";
import { sanitizeAuthRedirect } from "./cookies";

describe("sanitizeAuthRedirect", () => {
  it("returns /dashboard for missing input", () => {
    expect(sanitizeAuthRedirect(undefined)).toBe("/dashboard");
  });

  it("accepts normal relative paths", () => {
    expect(sanitizeAuthRedirect("/dashboard")).toBe("/dashboard");
    expect(sanitizeAuthRedirect("/dash")).toBe("/dash");
  });

  it("decodes once-encoded paths (%2Fdashboard → /dashboard)", () => {
    expect(sanitizeAuthRedirect("%2Fdashboard")).toBe("/dashboard");
  });

  it("rejects open redirects", () => {
    expect(sanitizeAuthRedirect("//evil")).toBe("/dashboard");
    expect(sanitizeAuthRedirect("https://evil")).toBe("/dashboard");
  });
});