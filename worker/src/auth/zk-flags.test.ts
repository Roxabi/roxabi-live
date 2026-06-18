import { describe, expect, it } from "vitest";
import { zkAccountKeyEnabled, zkStructureOnlyEnabled } from "./zk-flags";
import type { Env } from "../types";

function env(flags: Partial<Env>): Env {
  return flags as Env;
}

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