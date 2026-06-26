/**
 * SettingsDialog — account settings (profile, repositories, encryption, delete).
 * Ported from frontend/settings.js. The encryption passphrase-change section and
 * the reauth-gated delete (deferred from slice 7) are wired here in slice 10:
 * both privileged actions bounce through OAuth step-up via requestSettingsReauth
 * and resume on return (?settings=passphrase / ?settings=delete).
 */

import { clearDisplayName, getDisplayName, setDisplayName } from "@/auth/displayName";
import { useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { type ApiError, apiFetch } from "@/lib/api";
import { PassphraseChangeSection } from "@/zk/PassphraseChangeSection";
import { hasEnrolledThisSession } from "@/zk/enroll";
import { clearZkReauthProof, getZkReauthProof } from "@/zk/github";
import { clearLocalZkState } from "@/zk/reset";
import { requestSettingsReauth } from "@/zk/settingsReauth";
import type { MePayload } from "@roxabi-live/shared";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

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
  initialPassphraseForm = false,
  autoDelete = false,
  onResumeHandled,
}: {
  me: MePayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange?: (name: string) => void;
  /** Resume: jump straight to the passphrase form (returned from reauth). */
  initialPassphraseForm?: boolean;
  /** Resume: re-run the delete after reauth (returned from reauth). */
  autoDelete?: boolean;
  onResumeHandled?: () => void;
}) {
  const login = me.user.github_login;
  const logout = useLogout();
  const t = useT();
  const [name, setName] = useState(() => getDisplayName(login));
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const installUrl = configureUrl(me);
  const installations = me.installations ?? [];

  const deleteAccount = useMutation<{ redirected: boolean }, ApiError, void>({
    mutationFn: async () => {
      const payload: { reauth_proof?: string } = {};
      // Live enrollment state: cached /api/me can lag a same-session enroll.
      if (me.user.zk_enrolled || hasEnrolledThisSession()) {
        const proof = getZkReauthProof();
        if (!proof) {
          requestSettingsReauth("delete", window.location.pathname);
          return { redirected: true };
        }
        payload.reauth_proof = proof;
      }
      await apiFetch<{ ok: true }>("/api/account/delete", { method: "POST", body: payload });
      return { redirected: false };
    },
    onSuccess: async (res) => {
      if (res.redirected) return;
      clearZkReauthProof();
      await clearLocalZkState(login);
      clearDisplayName(login);
      logout.mutate(undefined);
    },
    onError: (err) => {
      if (err.status === 403) {
        requestSettingsReauth("delete", window.location.pathname);
        return;
      }
      setDeleteError(t("settings.deleteAccount.error"));
    },
  });

  function commitName(value: string) {
    const resolved = setDisplayName(login, value);
    setName(resolved);
    onNameChange?.(resolved);
  }

  function onDelete() {
    setDeleteError(null);
    if (
      !window.confirm(t("settings.deleteAccount.confirmPrompt"))
    ) {
      return;
    }
    deleteAccount.mutate();
  }

  // Resume: returned from reauth with ?settings=delete → re-run the delete once.
  const autoDeleteRan = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot resume; onDelete must not re-trigger it.
  useEffect(() => {
    if (autoDelete && open && !autoDeleteRan.current) {
      autoDeleteRan.current = true;
      onResumeHandled?.();
      onDelete();
    }
  }, [autoDelete, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="settings-dialog">
        <DialogTitle className="text-xl font-semibold text-foreground">{t("settings.title")}</DialogTitle>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t("settings.profile.heading")}</h3>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("settings.profile.displayName.label")}</span>
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
            {t("settings.profile.displayName.hint", { login })}
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t("settings.repos.heading")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.repos.hint")}
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
            <p className="text-sm text-muted-foreground">
              {t("settings.repos.empty")}
            </p>
          )}
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm text-primary underline-offset-4 hover:underline"
            >
              {t("settings.repos.configure")}
            </a>
          )}
        </section>

        {me.user.zk_account_key_enabled && (
          <PassphraseChangeSection
            login={login}
            initialOpen={initialPassphraseForm}
            onChanged={() => {
              onResumeHandled?.();
              onOpenChange(false);
            }}
          />
        )}

        <section className="space-y-2 rounded-md border border-blocked/30 bg-blocked/5 p-3">
          <h3 className="text-sm font-semibold text-blocked">{t("settings.deleteAccount.heading")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.deleteAccount.hint")}
          </p>
          <Button
            variant="destructive"
            size="sm"
            onClick={onDelete}
            loading={deleteAccount.isPending}
            data-testid="settings-delete"
          >
            {t("settings.deleteAccount.button")}
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
