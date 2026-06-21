import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();

vi.mock("./auth.js", () => ({
  api: (...args) => apiMock(...args),
}));

const { ensureSyncStarted, startSyncProgressMonitor } = await import("./initial-sync.js");

function mockStatus(body) {
  apiMock.mockResolvedValue({
    json: async () => body,
  });
}

describe("ensureSyncStarted", () => {
  it("fetches sync status once", async () => {
    mockStatus({
      sync_in_progress: false,
      sync_running: false,
      repos_total: 10,
      repos_synced: 10,
      issue_count: 42,
    });
    const status = await ensureSyncStarted();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(status.issue_count).toBe(42);
  });
});

describe("startSyncProgressMonitor", () => {
  let banner;

  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.mockReset();
    banner = document.createElement("div");
    banner.id = "sync-progress-banner";
    banner.setAttribute("hidden", "");
    document.body.appendChild(banner);
  });

  afterEach(() => {
    vi.useRealTimers();
    banner?.remove();
  });

  it("does not show banner when sync is complete", async () => {
    mockStatus({
      sync_in_progress: false,
      sync_running: false,
      repos_total: 5,
      repos_synced: 5,
      issue_count: 10,
    });

    const stop = startSyncProgressMonitor();
    await vi.advanceTimersByTimeAsync(0);

    expect(banner.hasAttribute("hidden")).toBe(true);
    stop();
  });

  it("shows repo progress and hides when done", async () => {
    mockStatus({
      sync_in_progress: true,
      sync_running: true,
      repos_total: 39,
      repos_synced: 12,
      issue_count: 80,
    });

    const stop = startSyncProgressMonitor();
    await vi.advanceTimersByTimeAsync(0);

    expect(banner.hasAttribute("hidden")).toBe(false);
    expect(banner.textContent).toContain("12 / 39");
    expect(banner.textContent).toContain("Synchronisation en cours");

    mockStatus({
      sync_in_progress: false,
      sync_running: false,
      repos_total: 39,
      repos_synced: 39,
      issue_count: 395,
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(banner.hasAttribute("hidden")).toBe(true);
    stop();
  });

  it("calls onReposAdvanced when repos_synced increases", async () => {
    const onReposAdvanced = vi.fn();
    mockStatus({
      sync_in_progress: true,
      sync_running: true,
      repos_total: 39,
      repos_synced: 5,
      issue_count: 20,
    });

    const stop = startSyncProgressMonitor({ onReposAdvanced });
    await vi.advanceTimersByTimeAsync(0);
    expect(onReposAdvanced).toHaveBeenCalledTimes(1);

    mockStatus({
      sync_in_progress: true,
      sync_running: true,
      repos_total: 39,
      repos_synced: 5,
      issue_count: 25,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onReposAdvanced).toHaveBeenCalledTimes(1);

    mockStatus({
      sync_in_progress: true,
      sync_running: true,
      repos_total: 39,
      repos_synced: 20,
      issue_count: 120,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onReposAdvanced).toHaveBeenCalledTimes(2);
    stop();
  });
});
