import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  api,
  escHtml,
  loginUrl,
  onboardingStepFromMe,
  pollInstallRefresh,
} from "./auth.js";

describe("loginUrl", () => {
  it("defaults redirect to dashboard", () => {
    expect(loginUrl()).toBe("/login?redirect=%2Fdashboard");
  });
});

describe("escHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escHtml("<script>\"'&")).toBe("&lt;script&gt;&quot;&#x27;&amp;");
  });
});

describe("api", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws AuthError on 401", async () => {
    fetch.mockResolvedValue({ status: 401, ok: false });
    await expect(api("/api/me")).rejects.toBeInstanceOf(AuthError);
  });
});

describe("onboardingStepFromMe", () => {
  it("returns valid onboarding steps", () => {
    expect(onboardingStepFromMe({ onboarding_step: "install" })).toBe("install");
    expect(onboardingStepFromMe({ onboarding_step: "consent" })).toBe("consent");
    expect(onboardingStepFromMe({ onboarding_step: "ready" })).toBe("ready");
  });

  it("throws when onboarding_step is missing or invalid", () => {
    expect(() => onboardingStepFromMe({})).toThrow("invalid onboarding_step");
    expect(() => onboardingStepFromMe({ onboarding_step: "bogus" })).toThrow();
  });
});

describe("pollInstallRefresh", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns linked payload on 200", async () => {
    fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ status: "linked", onboarding_step: "consent" }),
    });
    const { linked } = await pollInstallRefresh(1);
    expect(linked.onboarding_step).toBe("consent");
  });

  it("captures oauth_fallback from 202 responses", async () => {
    fetch
      .mockResolvedValueOnce({
        status: 202,
        ok: false,
        json: async () => ({
          retry_after_ms: 1,
          oauth_fallback: "/login?intent=install&redirect=%2Ffoo",
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ status: "linked" }),
      });
    const { oauthFallback } = await pollInstallRefresh(2);
    expect(oauthFallback).toBe("/login?intent=install&redirect=%2Ffoo");
  });

  it("throws AuthError on 401", async () => {
    fetch.mockResolvedValueOnce({ status: 401, ok: false });
    await expect(pollInstallRefresh(1)).rejects.toBeInstanceOf(AuthError);
  });
});
