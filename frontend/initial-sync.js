// initial-sync.js — non-blocking first-import progress (#223)

import { api } from "./auth.js";

const $ = (id) => document.getElementById(id);

const POLL_MS = 2000;

/**
 * Kick bootstrap scheduling via /api/sync/status (side-effect on server).
 * @returns {Promise<object|null>}
 */
export async function ensureSyncStarted() {
  return fetchStatus();
}

/**
 * Non-blocking repo import banner. Dashboard renders immediately; poll refreshes
 * the graph when new repos land.
 * @param {{ onReposAdvanced?: (status: object) => void }} [callbacks]
 * @returns {() => void} stop polling
 */
export function startSyncProgressMonitor(callbacks = {}) {
  const banner = $("sync-progress-banner");
  if (!banner) return () => {};

  let timer = null;
  let lastReposSynced = -1;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const update = async () => {
    const status = await fetchStatus();
    if (!status) return;

    const active = status.sync_in_progress || status.sync_running;
    if (!active) {
      hideBanner(banner);
      stop();
      return;
    }

    showBanner(banner, status);
    if (status.repos_synced > lastReposSynced) {
      lastReposSynced = status.repos_synced;
      callbacks.onReposAdvanced?.(status);
    }
  };

  void update();
  timer = setInterval(() => {
    void update();
  }, POLL_MS);

  return stop;
}

/** @deprecated Use ensureSyncStarted + startSyncProgressMonitor — kept for tests. */
export async function waitForInitialSync() {
  await ensureSyncStarted();
}

async function fetchStatus() {
  try {
    const resp = await api("/api/sync/status");
    return resp.json();
  } catch {
    return null;
  }
}

function showBanner(banner, status) {
  const total = status.repos_total ?? 0;
  const synced = status.repos_synced ?? 0;
  const issues = status.issue_count ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((synced / total) * 100)) : 0;

  banner.innerHTML = `
    <div class="sync-progress-inner" role="status" aria-live="polite">
      <div class="sync-progress-text">
        <strong>Synchronisation en cours</strong>
        <span class="sync-progress-detail">${synced} / ${total} dépôts importés · ${issues} issues</span>
      </div>
      <div class="sync-progress-track" aria-hidden="true">
        <div class="sync-progress-fill" style="width:${pct}%"></div>
      </div>
    </div>
  `;
  banner.removeAttribute("hidden");
}

function hideBanner(banner) {
  banner.setAttribute("hidden", "");
  banner.innerHTML = "";
}
