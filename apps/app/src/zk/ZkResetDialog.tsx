/**
 * ZkResetDialog — lost-passphrase recovery dialogs, ported from
 * frontend/zk-reset.js renderResetWarning / renderResetExecute.
 *
 *  Warning  → "Verify with GitHub" sets reset-pending + redirects through OAuth
 *             step-up (zkReauthLoginUrl). On return, ?zk_reauth= is consumed into
 *             a proof and ZkGate shows the Execute dialog.
 *  Execute  → confirms the irreversible server purge + local wipe, then reloads
 *             into the enroll gate.
 */

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useState } from "react";
import { ZkFormError, ZkGateDialog } from "./ZkDialogShell";
import { clearZkReauthProof, zkReauthLoginUrl } from "./github";
import {
  ZkResetError,
  clearZkResetPending,
  resetZkAccountAndReenroll,
  setZkResetPending,
} from "./reset";

export function ZkResetWarningDialog({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  function onVerify() {
    setZkResetPending();
    const redirect = `${window.location.pathname}${window.location.search}`;
    window.location.href = zkReauthLoginUrl(redirect);
  }
  return (
    <ZkGateDialog title={t("zk.reset.warning.title")} testId="zk-reset-warning">
      <p className="rounded-md border border-blocked/30 bg-blocked/10 p-3 text-sm text-foreground">
        <strong>{t("zk.reset.warning.irreversibleBold")}</strong> {t("zk.reset.warning.body")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("zk.reset.warning.githubRequired")}
      </p>
      <div className="flex items-center justify-between gap-3 pt-1">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            clearZkResetPending();
            onCancel();
          }}
          data-testid="zk-reset-cancel"
        >
          {t("zk.common.cancel")}
        </Button>
        <Button type="button" onClick={onVerify} data-testid="zk-reset-verify">
          {t("zk.reset.warning.verifyGithub")}
        </Button>
      </div>
    </ZkGateDialog>
  );
}

export function ZkResetExecuteDialog({
  login,
  onCancel,
}: {
  login: string;
  onCancel: () => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onConfirm() {
    setError(null);
    setBusy(true);
    try {
      await resetZkAccountAndReenroll(login);
      // resetZkAccountAndReenroll reloads on success.
    } catch (err) {
      const code = err instanceof ZkResetError ? err.code : undefined;
      const message = err instanceof Error ? err.message : "";
      if (code === "reauth_required" || message === "reauth_required") {
        setError(t("zk.reset.execute.errorReauthExpired"));
        clearZkReauthProof();
      } else if (code === "rate_limited") {
        setError(t("zk.reset.execute.errorRateLimited"));
      } else {
        setError(t("zk.reset.execute.errorGeneric"));
      }
      setBusy(false);
    }
  }

  return (
    <ZkGateDialog title={t("zk.reset.execute.title")} testId="zk-reset-execute">
      <p className="text-sm text-muted-foreground">
        {t("zk.reset.execute.description")}
      </p>
      <ZkFormError message={error} />
      <div className="flex items-center justify-between gap-3 pt-1">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            clearZkResetPending();
            clearZkReauthProof();
            onCancel();
          }}
          data-testid="zk-reset-abort"
        >
          {t("zk.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          loading={busy}
          onClick={onConfirm}
          data-testid="zk-reset-confirm"
        >
          {t("zk.reset.execute.confirmButton")}
        </Button>
      </div>
    </ZkGateDialog>
  );
}
