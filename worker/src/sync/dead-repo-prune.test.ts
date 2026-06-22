import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDb } from "../test-utils";
import { maybePruneDeadAccessibleRepos } from "./dead-repo-prune";

vi.mock("../auth/installToken", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("ghs_test"),
}));

vi.mock("./bootstrap", () => ({
  isBootstrapComplete: vi.fn().mockResolvedValue(false),
  listUnsyncedRepos: vi.fn().mockResolvedValue(["Roxabi/gone"]),
}));

import { getInstallationToken } from "../auth/installToken";
import { isBootstrapComplete, listUnsyncedRepos } from "./bootstrap";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(isBootstrapComplete).mockResolvedValue(false);
  vi.mocked(listUnsyncedRepos).mockResolvedValue(["Roxabi/gone"]);
  vi.mocked(getInstallationToken).mockResolvedValue("ghs_test");
});

describe("maybePruneDeadAccessibleRepos", () => {
  it("skips when bootstrap is complete", async () => {
    vi.mocked(isBootstrapComplete).mockResolvedValueOnce(true);
    const { db } = captureDb(() => []);
    const pruned = await maybePruneDeadAccessibleRepos({ DB: db } as never);
    expect(pruned).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prunes repos GitHub returns 404 for", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
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
    expect(stmts().some((s) => s.sql.includes("DELETE FROM tenant_repo_access"))).toBe(true);
  });
});
