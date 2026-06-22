import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { applyStagingPrivacyHeaders, isStagingEnv, stagingRobotsResponse } from "./staging-privacy";

function env(slug?: string): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    GITHUB_WEBHOOK_SECRET: "x",
    GITHUB_APP_ID: "1",
    GITHUB_APP_CLIENT_ID: "c",
    GITHUB_APP_CLIENT_SECRET: "s",
    GITHUB_APP_PRIVATE_KEY: "k",
    GITHUB_APP_WEBHOOK_SECRET: "w",
    GITHUB_APP_SLUG: slug,
  };
}

describe("isStagingEnv", () => {
  it("is true only for the staging app slug", () => {
    expect(isStagingEnv(env("roxabi-live-staging"))).toBe(true);
    expect(isStagingEnv(env("roxabi-live"))).toBe(false);
    expect(isStagingEnv(env())).toBe(false);
  });
});

describe("stagingRobotsResponse", () => {
  it("blocks all crawlers and sets noindex headers", async () => {
    const res = stagingRobotsResponse();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  });
});

describe("applyStagingPrivacyHeaders", () => {
  it("adds X-Robots-Tag without dropping existing headers", () => {
    const original = new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const wrapped = applyStagingPrivacyHeaders(original);
    expect(wrapped.headers.get("Content-Type")).toBe("text/plain");
    expect(wrapped.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  });
});
