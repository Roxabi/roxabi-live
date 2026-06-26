import { describe, expect, it } from "vitest";
import { sanitizeAuthRedirect, stripInstallParam } from "./cookies";

describe("sanitizeAuthRedirect", () => {
  // Post-cutover the safe default is the SPA index "/" (app.live.roxabi.dev),
  // not the legacy "/dashboard" shell.
  it("returns / for missing input", () => {
    expect(sanitizeAuthRedirect(undefined)).toBe("/");
  });

  it("accepts normal relative paths", () => {
    expect(sanitizeAuthRedirect("/dashboard")).toBe("/dashboard");
    expect(sanitizeAuthRedirect("/dash")).toBe("/dash");
  });

  it("decodes once-encoded paths (%2Fdashboard → /dashboard)", () => {
    expect(sanitizeAuthRedirect("%2Fdashboard")).toBe("/dashboard");
  });

  it("rejects open redirects", () => {
    expect(sanitizeAuthRedirect("//evil")).toBe("/");
    expect(sanitizeAuthRedirect("https://evil")).toBe("/");
  });

  it("rejects paths containing quotes or angle brackets", () => {
    expect(sanitizeAuthRedirect('/x" onclick')).toBe("/");
    expect(sanitizeAuthRedirect("/x<script>")).toBe("/");
    expect(sanitizeAuthRedirect("/x'y")).toBe("/");
  });
});

describe("stripInstallParam", () => {
  it("keeps SPA index / after stripping install (not legacy /dashboard)", () => {
    expect(stripInstallParam("/?install=1")).toBe("/");
    expect(stripInstallParam("/")).toBe("/");
  });

  it("strips install from deeper paths", () => {
    expect(stripInstallParam("/dashboard/?install=1")).toBe("/dashboard");
  });
});
