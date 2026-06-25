import { describe, expect, it } from "vitest";
import { buildInstallOptions, deriveOnboardingStep } from "./onboarding";

const SESSION = {
  userId: 1,
  tenantId: 9,
  githubId: 42,
  githubLogin: "alice",
};

describe("deriveOnboardingStep", () => {
  it("returns install when no linked installations", () => {
    expect(deriveOnboardingStep({ ...SESSION, tenantId: null }, [], null)).toBe("install");
  });

  it("returns consent when linked but no consent_at", () => {
    expect(deriveOnboardingStep(SESSION, [{ tenant_id: 9 }], null)).toBe("consent");
  });

  it("returns ready when linked and consented", () => {
    expect(deriveOnboardingStep(SESSION, [{ tenant_id: 9 }], "2026-01-01")).toBe("ready");
  });
});

describe("buildInstallOptions", () => {
  it("builds personal, org, and picker options", () => {
    const opts = buildInstallOptions([
      { id: 1, login: "alice", type: "User" },
      { id: 2, login: "Roxabi", type: "Organization" },
    ]);
    expect(opts.map((o) => o.kind)).toEqual(["personal", "org"]);
  });
});
