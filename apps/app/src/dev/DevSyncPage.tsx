import { SyncProgressBanner } from "@/components/SyncProgressBanner";
import { Button } from "@/components/ui/button";
import type { SyncStatus } from "@roxabi-live/shared";
import { useState } from "react";

/**
 * DEV-only route (/dev/sync) that drives SyncProgressBanner from mock states, so
 * the banner rendering (progress bar, halted alert, hidden) can be
 * browser-verified without a live bootstrap sync. Not in production builds.
 */
const base: SyncStatus = {
  issue_count: 0,
  sync_running: false,
  initial_sync: false,
  repos_total: 8,
  repos_synced: 0,
  sync_in_progress: false,
  sync_halted: false,
};

const SCENARIOS: { label: string; status: SyncStatus | null }[] = [
  { label: "idle (none)", status: null },
  { label: "0%", status: { ...base, sync_in_progress: true, repos_synced: 0, issue_count: 0 } },
  { label: "50%", status: { ...base, sync_in_progress: true, repos_synced: 4, issue_count: 120 } },
  { label: "100%", status: { ...base, sync_in_progress: true, repos_synced: 8, issue_count: 240 } },
  {
    label: "done",
    status: { ...base, sync_in_progress: false, repos_synced: 8, issue_count: 240 },
  },
  { label: "halted", status: { ...base, sync_halted: true, repos_synced: 3 } },
];

export default function DevSyncPage() {
  const [idx, setIdx] = useState(1);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">SyncProgressBanner — fixture</h1>
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s, i) => (
          <Button
            key={s.label}
            data-testid={`sync-scenario-${s.label}`}
            variant={i === idx ? "default" : "outline"}
            onClick={() => setIdx(i)}
          >
            {s.label}
          </Button>
        ))}
      </div>
      <SyncProgressBanner status={SCENARIOS[idx].status} />
    </div>
  );
}
