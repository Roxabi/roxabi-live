import type { SyncStatus } from "@roxabi-live/shared";

/**
 * Non-blocking first-import banner (ported from frontend/initial-sync.js). Shows
 * a progress bar while a bootstrap sync is in progress, an alert if it halted on
 * a GitHub auth error, and nothing once the corpus is ready. Pure — the polling
 * lives in useSyncProgressMonitor.
 */
export function SyncProgressBanner({ status }: { status: SyncStatus | null }) {
  if (!status) return null;

  if (status.sync_halted) {
    return (
      <div
        role="alert"
        data-testid="sync-banner-halted"
        className="rounded-lg border border-blocked/30 bg-blocked/10 p-3 text-xs"
      >
        <strong className="text-foreground">Sync interrupted</strong>
        <span className="ml-2 text-muted-foreground">
          {status.repos_synced} / {status.repos_total} repos · GitHub authentication error
        </span>
      </div>
    );
  }

  const active = status.sync_in_progress || status.sync_running;
  if (!active) return null;

  const total = status.repos_total ?? 0;
  const synced = status.repos_synced ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((synced / total) * 100)) : 0;

  return (
    <output
      aria-live="polite"
      data-testid="sync-banner"
      className="block rounded-lg border border-primary/30 bg-primary/5 p-3"
    >
      <div className="flex items-center justify-between text-xs">
        <strong className="text-foreground">Syncing your repositories…</strong>
        <span className="text-muted-foreground">
          {synced} / {total} repos · {status.issue_count} issues
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          data-testid="sync-bar-fill"
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </output>
  );
}
