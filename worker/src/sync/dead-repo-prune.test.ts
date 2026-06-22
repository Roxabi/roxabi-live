import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDb } from "../test-utils";
import { maybePruneDeadAccessibleRepos } from "./dead-repo-prune";

vi.mock("../auth/installToken", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("ghs_test"),
  listInstallationRepos: vi.fn().mockResolvedValue([{ repo: "Roxabi/gone", isPrivate: false }]),
}));

vi.mock("./bootstrap", () => ({
  isBootstrapComplete: vi.fn().mockResolvedValue(false),
  listUnsyncedRepos: vi.fn().mockResolvedValue(["Roxabi/gone"]),
}));

vi.mock("./repo-probe", () => ({
  isRepoResolvable: vi.fn().mockResolvedValue(false),
}));

import { getInstallationToken, listInstallationRepos } from "../auth/installToken";
import { isBootstrapComplete, listUnsyncedRepos } from "./bootstrap";
import { isRepoResolvable } from "./repo-probe";

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(isBootstrapComplete).mockResolvedValue(false);
  vi.mocked(listUnsyncedRepos).mockResolvedValue(["Roxabi/gone"]);
  vi.mocked(getInstallationToken).mockResolvedValue("ghs_test");
  vi.mocked(listInstallationRepos).mockResolvedValue([{ repo: "Roxabi/gone", isPrivate: false }]);
  vi.mocked(isRepoResolvable).mockResolvedValue(false);
});

describe("maybePruneDeadAccessibleRepos", () => {
  it("skips when bootstrap is complete", async () => {
    vi.mocked(isBootstrapComplete).mockResolvedValueOnce(true);
    const { db } = captureDb(() => []);
    const pruned = await maybePruneDeadAccessibleRepos({ DB: db } as never);
    expect(pruned).toBe(0);
    expect(isRepoResolvable).not.toHaveBeenCalled();
  });

  it("prunes repos GraphQL cannot resolve", async () => {
    const { db, stmts } = captureDb((sql, args) => {
      if (sql.includes("SELECT value FROM sync_control") && args[0] === "dead_repo_prune_at") {
        return [];
      }
      if (sql.includes("FROM tenants")) {
        return [{ id: 1, installation_id: 99 }];
      }
      return [];
    });
    const pruned = await maybePruneDeadAccessibleRepos({ DB: db } as never);
    expect(pruned).toBe(1);
    expect(isRepoResolvable).toHaveBeenCalledWith("ghs_test", "Roxabi/gone", {
      isPrivate: false,
    });
    expect(stmts().some((s) => s.sql.includes("DELETE FROM tenant_repo_access"))).toBe(true);
  });
});
