import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDb } from "../test-utils";
import { maybeRefreshTenantDiscovery } from "./discovery-refresh";

vi.mock("./tenants", () => ({
  discoverTenants: vi.fn().mockResolvedValue({
    repoMap: new Map(),
    staleTenantReposRemoved: 2,
    archivedRepos: new Set(),
  }),
}));

vi.mock("./bootstrap", () => ({
  isBootstrapComplete: vi.fn().mockResolvedValue(false),
}));

import { isBootstrapComplete } from "./bootstrap";
import { discoverTenants } from "./tenants";

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(isBootstrapComplete).mockResolvedValue(false);
});

describe("maybeRefreshTenantDiscovery", () => {
  it("skips when bootstrap is already complete", async () => {
    vi.mocked(isBootstrapComplete).mockResolvedValueOnce(true);
    const { db } = captureDb(() => []);
    const removed = await maybeRefreshTenantDiscovery({ DB: db } as never);
    expect(removed).toBe(0);
    expect(discoverTenants).not.toHaveBeenCalled();
  });

  it("debounces discovery refresh within 60s", async () => {
    const recent = new Date().toISOString();
    const { db } = captureDb((sql, args) => {
      if (sql.includes("SELECT value FROM sync_control") && args[0] === "discovery_refresh_at") {
        return [{ value: recent }];
      }
      return [];
    });
    const removed = await maybeRefreshTenantDiscovery({ DB: db } as never);
    expect(removed).toBe(0);
    expect(discoverTenants).not.toHaveBeenCalled();
  });
});
