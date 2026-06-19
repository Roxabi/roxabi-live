import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { assertZkConfigCoherent, zkAccountKeyEnabled, zkStructureOnlyEnabled } from "./zk-flags";

function env(flags: Partial<Env>): Env {
  return flags as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zkAccountKeyEnabled", () => {
  it("is false when unset", () => {
    expect(zkAccountKeyEnabled(env({}))).toBe(false);
  });

  it("is true for 1 or true", () => {
    expect(zkAccountKeyEnabled(env({ ZK_ACCOUNT_KEY: "1" }))).toBe(true);
    expect(zkAccountKeyEnabled(env({ ZK_ACCOUNT_KEY: "true" }))).toBe(true);
    expect(zkAccountKeyEnabled(env({ ZK_ACCOUNT_KEY: "TRUE" }))).toBe(true);
  });

  it("is false for 0", () => {
    expect(zkAccountKeyEnabled(env({ ZK_ACCOUNT_KEY: "0" }))).toBe(false);
  });
});

describe("zkStructureOnlyEnabled", () => {
  it("is false when unset", () => {
    expect(zkStructureOnlyEnabled(env({}))).toBe(false);
  });

  it("is true for 1", () => {
    expect(zkStructureOnlyEnabled(env({ ZK_STRUCTURE_ONLY: "1" }))).toBe(true);
  });
});

describe("assertZkConfigCoherent", () => {
  it("logs an error when account key is on but structure-only is off", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertZkConfigCoherent(env({ ZK_ACCOUNT_KEY: "1", ZK_STRUCTURE_ONLY: "0" }));
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain("ZK_STRUCTURE_ONLY=1");
  });

  it("is silent when both flags are on", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertZkConfigCoherent(env({ ZK_ACCOUNT_KEY: "1", ZK_STRUCTURE_ONLY: "1" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("is silent when account key is off", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertZkConfigCoherent(env({ ZK_ACCOUNT_KEY: "0", ZK_STRUCTURE_ONLY: "0" }));
    expect(spy).not.toHaveBeenCalled();
  });
});
