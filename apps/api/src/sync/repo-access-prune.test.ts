import { describe, expect, it } from "vitest";
import { captureDb } from "../test-utils";
import { isInaccessibleRepoError, pruneInaccessibleRepo } from "./repo-access-prune";

describe("isInaccessibleRepoError", () => {
  it("detects GraphQL repository resolution failures", () => {
    expect(
      isInaccessibleRepoError(
        new Error(
          'GraphQL errors: [{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]',
        ),
      ),
    ).toBe(true);
    expect(isInaccessibleRepoError(new Error("rate limit"))).toBe(false);
  });
});

describe("pruneInaccessibleRepo", () => {
  it("deletes access, registry, and sync_state rows", async () => {
    const { db, stmts } = captureDb(() => []);
    await pruneInaccessibleRepo(db, "Roxabi/gone");
    const sqls = stmts().map((s) => s.sql);
    expect(sqls.some((s) => s.includes("DELETE FROM tenant_repo_access"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM repos"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM sync_state"))).toBe(true);
  });
});
