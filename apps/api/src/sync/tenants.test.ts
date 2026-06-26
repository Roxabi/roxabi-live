import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureDb } from "../test-utils";

vi.mock("../auth/installToken", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("tok"),
  listInstallationRepos: vi.fn().mockResolvedValue([]),
}));

vi.mock("./repo-probe", () => ({
  filterResolvableRepos: vi.fn().mockResolvedValue({ kept: [], dropped: [] }),
}));

vi.mock("./control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./control")>();
  return {
    ...actual,
    acquireSyncLock: vi.fn().mockResolvedValue(true),
    releaseSyncLock: vi.fn().mockResolvedValue(undefined),
    batchChunked: vi.fn().mockResolvedValue(undefined),
    incrementAuthFailures: vi.fn().mockResolvedValue(0),
  };
});

import { listInstallationRepos } from "../auth/installToken";
import { filterResolvableRepos } from "./repo-probe";
import { discoverTenants } from "./tenants";

beforeEach(() => {
  vi.mocked(listInstallationRepos).mockResolvedValue([
    { repo: "Roxabi/synced", isPrivate: false },
    { repo: "Roxabi/ghost", isPrivate: false },
  ]);
  vi.mocked(filterResolvableRepos).mockImplementation(async (_token, repos) => ({
    kept: repos,
    dropped: [],
  }));
});

describe("discoverTenants — resolvable filter", () => {
  it("probes only repos missing a sync_state watermark", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("FROM tenants")) {
        return [{ id: 1, installation_id: 10 }];
      }
      if (sql.includes("FROM sync_state")) {
        return [{ repo: "Roxabi/synced" }];
      }
      if (sql.includes("SELECT repo FROM tenant_repo_access")) {
        return [];
      }
      return [];
    });

    await discoverTenants(db, { DB: db } as never);

    expect(filterResolvableRepos).toHaveBeenCalledWith("tok", [
      { repo: "Roxabi/ghost", isPrivate: false },
    ]);
  });
});
