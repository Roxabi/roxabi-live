/**
 * PassphraseChangeSection — Settings panel control to rotate the encryption
 * passphrase. Ported from frontend/settings.js wirePassphraseChange. The form is
 * gated behind an OAuth reauth proof: clicking "Changer" with no proof parks the
 * intent and bounces through step-up, returning to ?settings=passphrase which
 * reopens Settings with the form already shown (initialOpen).
 */

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useState } from "react";
import { ZkFormError } from "./ZkDialogShell";
import { requestSettingsReauth } from "./settingsReauth";
import { hasReauthProof, passphraseChangeError, usePassphraseChange } from "./usePassphraseChange";

export function PassphraseChangeSection({
  login,
  initialOpen = false,
  onChanged,
}: {
  login: string;
  initialOpen?: boolean;
  onChanged?: () => void;
}) {
  const t = useT();
  const [formOpen, setFormOpen] = useState(initialOpen);
  const [current, setCurrent] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = usePassphraseChange(login);

  function onChangeClick() {
    if (!hasReauthProof()) {
      requestSettingsReauth("passphrase", window.location.pathname);
      return;
    }
    setFormOpen(true);
  }

  function onSave() {
    change.mutate(
      { current, newPass, confirm },
      {
        onSuccess: () => {
          setFormOpen(false);
          setCurrent("");
          setNewPass("");
          setConfirm("");
          onChanged?.();
        },
      },
    );
  }

  const input =
    "h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{t("settings.encryption.heading")}</h3>
      {!formOpen ? (
        <Button variant="outline" size="sm" onClick={onChangeClick} data-testid="zk-change-pass">
          {t("zk.reset.changePassphraseButton")}
        </Button>
      ) : (
        <div className="space-y-2" data-testid="zk-pass-form">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("zk.reset.currentPassphrase.label")}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              data-testid="zk-pass-current"
              className={input}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("zk.reset.newPassphrase.label")}</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              data-testid="zk-pass-new"
              className={input}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("zk.reset.confirmPassphrase.label")}</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              data-testid="zk-pass-confirm"
              className={input}
            />
          </label>
          {change.isError && <ZkFormError message={passphraseChangeError(change.error)} />}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFormOpen(false)}
              data-testid="zk-pass-cancel"
            >
              {t("zk.reset.cancel")}
            </Button>
            <Button
              size="sm"
              loading={change.isPending}
              onClick={onSave}
              data-testid="zk-pass-save"
            >
              {t("zk.reset.saveButton")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
