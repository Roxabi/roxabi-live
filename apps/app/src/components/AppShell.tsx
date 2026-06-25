/**
 * AppShell — authenticated app chrome (sticky header + main). Rendered only
 * inside the ready branch of AuthGate, so useAuth() is always populated here.
 *
 * Header layout mirrors the legacy dashboard (frontend/dashboard/index.html):
 *   left  — brand mark + "Roxabi <accent>Live</accent>" + corpus stats subtitle
 *   right — view segs (Graph/List/Table) + ZK lock + org picker + user menu
 */

import { useAuth } from "@/auth/AuthContext";
import { OrgPicker } from "@/auth/OrgPicker";
import { SettingsUiProvider } from "@/auth/SettingsUi";
import { UserMenu } from "@/auth/UserMenu";
import { BrandMark } from "@/components/BrandMark";
import { ViewToggle } from "@/components/ViewToggle";
import { useGraphData } from "@/hooks/useGraphData";
import { ZkLockButton } from "@/zk/ZkLockButton";

/** Corpus counts subtitle — "N issues · N open · N closed" (legacy #subtitle). */
function CorpusStats() {
  const { nodes, isLoading } = useGraphData();
  if (isLoading && nodes.length === 0) {
    return <div className="mt-1 font-mono text-xs text-muted-foreground">Loading…</div>;
  }
  const open = nodes.reduce((n, x) => n + (x.state === "open" ? 1 : 0), 0);
  const closed = nodes.length - open;
  return (
    <div className="mt-1 font-mono text-xs text-muted-foreground">
      {nodes.length} issues · {open} open · {closed} closed
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const me = useAuth();

  return (
    <SettingsUiProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-50 border-b border-border bg-background px-6 pb-3 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-center gap-3">
              <BrandMark className="size-7 shrink-0" />
              <div>
                <h1 className="text-[22px] font-black leading-none tracking-[-0.04em] text-foreground">
                  Roxabi <span className="text-primary">Live</span>
                </h1>
                <CorpusStats />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ViewToggle />
              <ZkLockButton />
              <OrgPicker me={me} />
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="px-6 py-5">{children}</main>
      </div>
    </SettingsUiProvider>
  );
}
