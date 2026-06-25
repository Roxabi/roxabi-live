import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITHUB_APP_SLUG,
  githubInstallUrl,
  parseInstallTargets,
  resolveGithubAppSlug,
} from "./github-install";

describe("resolveGithubAppSlug", () => {
  it("falls back to the prod default when unset", () => {
    expect(resolveGithubAppSlug()).toBe(DEFAULT_GITHUB_APP_SLUG);
    expect(resolveGithubAppSlug("  ")).toBe(DEFAULT_GITHUB_APP_SLUG);
  });

  it("uses the env override when provided", () => {
    expect(resolveGithubAppSlug("roxabi-live-staging")).toBe("roxabi-live-staging");
  });
});

describe("githubInstallUrl", () => {
  it("returns base install URL without target", () => {
    expect(githubInstallUrl()).toBe(
      `https://github.com/apps/${DEFAULT_GITHUB_APP_SLUG}/installations/new`,
    );
  });

  it("uses the staging slug override when provided", () => {
    expect(githubInstallUrl(undefined, "roxabi-live-staging")).toBe(
      "https://github.com/apps/roxabi-live-staging/installations/new",
    );
  });

  it("pre-selects user account via target_id and target_type", () => {
    const url = new URL(githubInstallUrl({ id: 42, login: "alice", type: "User" }));
    expect(url.searchParams.get("target_id")).toBe("42");
    expect(url.searchParams.get("target_type")).toBe("User");
  });

  it("pre-selects organisation via target_id and target_type", () => {
    const url = new URL(githubInstallUrl({ id: 99, login: "Roxabi", type: "Organization" }));
    expect(url.searchParams.get("target_id")).toBe("99");
    expect(url.searchParams.get("target_type")).toBe("Organization");
  });
});

describe("parseInstallTargets", () => {
  it("returns [] for null/empty/invalid JSON", () => {
    expect(parseInstallTargets(null)).toEqual([]);
    expect(parseInstallTargets("")).toEqual([]);
    expect(parseInstallTargets("{")).toEqual([]);
    expect(parseInstallTargets("[]")).toEqual([]);
  });

  it("filters malformed entries", () => {
    const raw = JSON.stringify([
      { id: 1, login: "alice", type: "User" },
      { id: "bad", login: "x", type: "User" },
      { login: "no-id", type: "Organization" },
    ]);
    expect(parseInstallTargets(raw)).toEqual([{ id: 1, login: "alice", type: "User" }]);
  });

  it("returns valid entries unchanged (happy path)", () => {
    const targets = [
      { id: 1, login: "alice", type: "User" as const },
      { id: 2, login: "Roxabi", type: "Organization" as const },
    ];
    expect(parseInstallTargets(JSON.stringify(targets))).toEqual(targets);
  });
});
