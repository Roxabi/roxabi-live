/**
 * AppShell — authenticated app chrome (header + main). Rendered only inside the
 * ready branch of AuthGate, so useAuth() is always populated here.
 */

import { useAuth } from "@/auth/AuthContext";
import { OrgPicker } from "@/auth/OrgPicker";
import { SettingsUiProvider } from "@/auth/SettingsUi";
import { UserMenu } from "@/auth/UserMenu";
import { ZkLockButton } from "@/zk/ZkLockButton";

export function AppShell({ children }: { children: React.ReactNode }) {
  const me = useAuth();

  return (
    <SettingsUiProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="flex items-center gap-3 border-b border-border px-6 py-3">
          <span className="text-lg font-semibold tracking-tight text-foreground">Roxabi Live</span>
          <div className="ml-auto flex items-center gap-3">
            <ZkLockButton />
            <OrgPicker me={me} />
            <UserMenu />
          </div>
        </header>
        <main className="p-6">{children}</main>
      </div>
    </SettingsUiProvider>
  );
}
