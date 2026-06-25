/**
 * SettingsDialog — account settings (profile, repositories, permissions, delete).
 * Ported from frontend/settings.js. The zk passphrase-change section and the
 * reauth-gated delete path are wired in the ZK slices (9-10); for now delete
 * uses the no-reauth path and surfaces a clear message if step-up is required.
 */

import { clearDisplayName, getDisplayName, setDisplayName } from "@/auth/displayName";
import { useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { type ApiError, apiFetch } from "@/lib/api";
import type { MePayload } from "@roxabi-live/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

function configureUrl(me: MePayload): string | null {
  const opts = me.install_options ?? [];
  return (
    opts.find((o) => o.kind === "personal")?.url ??
    opts.find((o) => o.kind === "picker")?.url ??
    opts[0]?.url ??
    null
  );
}

export function SettingsDialog({
  me,
  open,
  onOpenChange,
  onNameChange,
}: {
  me: MePayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange?: (name: string) => void;
}) {
  const login = me.user.github_login;
  const logout = useLogout();
  const [name, setName] = useState(() => getDisplayName(login));
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const installUrl = configureUrl(me);
  const installations = me.installations ?? [];

  const deleteAccount = useMutation<void, ApiError, void>({
    mutationFn: async () => {
      await apiFetch<{ ok: true }>("/api/account/delete", { method: "POST", body: {} });
    },
    onSuccess: () => {
      clearDisplayName(login);
      logout.mutate({ to: "/" });
    },
    onError: (err) => {
      setDeleteError(
        err.status === 403
          ? "La suppression exige une ré-authentification chiffrée (à venir)."
          : "Suppression impossible — réessayez.",
      );
    },
  });

  function commitName(value: string) {
    const resolved = setDisplayName(login, value);
    setName(resolved);
    onNameChange?.(resolved);
  }

  function onDelete() {
    setDeleteError(null);
    if (!window.confirm("Delete all your Roxabi Live data and sign out? This cannot be undone.")) {
      return;
    }
    deleteAccount.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="settings-dialog">
        <DialogTitle className="text-xl font-semibold text-foreground">Settings</DialogTitle>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Profile</h3>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Display name</span>
            <input
              type="text"
              value={name}
              maxLength={64}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => commitName(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Shown in the header. GitHub login: <strong className="text-foreground">{login}</strong>.
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Repositories</h3>
          <p className="text-xs text-muted-foreground">
            Add or remove repositories the GitHub App can access.
          </p>
          {installations.length ? (
            <ul className="space-y-1 text-sm">
              {installations.map((i) => (
                <li key={i.tenant_id} className="text-foreground">
                  <strong>{i.account_login}</strong>{" "}
                  <span className="text-muted-foreground">({i.account_type})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No installation linked yet.</p>
          )}
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm text-primary underline-offset-4 hover:underline"
            >
              Configure repositories on GitHub
            </a>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">GitHub App permissions</h3>
          <a
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm text-primary underline-offset-4 hover:underline"
          >
            Manage permissions on GitHub
          </a>
        </section>

        <section className="space-y-2 rounded-md border border-blocked/30 bg-blocked/5 p-3">
          <h3 className="text-sm font-semibold text-blocked">Delete account</h3>
          <p className="text-xs text-muted-foreground">
            Wipes your Roxabi data and signs you out. Revoke the app on GitHub separately.
          </p>
          <Button
            variant="destructive"
            size="sm"
            onClick={onDelete}
            loading={deleteAccount.isPending}
          >
            Delete my data &amp; sign out
          </Button>
          {deleteError && (
            <p className="text-xs text-blocked" role="alert">
              {deleteError}
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
