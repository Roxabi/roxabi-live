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
  function onVerify() {
    setZkResetPending();
    const redirect = `${window.location.pathname}${window.location.search}`;
    window.location.href = zkReauthLoginUrl(redirect);
  }
  return (
    <ZkGateDialog title="Réinitialiser le chiffrement ?" testId="zk-reset-warning">
      <p className="rounded-md border border-blocked/30 bg-blocked/10 p-3 text-sm text-foreground">
        <strong>Cette action est irréversible.</strong> Tous les titres d'issues chiffrés stockés
        pour votre compte sur le serveur seront supprimés. Vos titres précédemment chiffrés ne
        pourront plus être déchiffrés — ils sont définitivement perdus. Vous choisirez une nouvelle
        passphrase et re-scellerez le contenu depuis GitHub.
      </p>
      <p className="text-sm text-muted-foreground">
        Une connexion GitHub est requise pour confirmer cette action.
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
          Annuler
        </Button>
        <Button type="button" onClick={onVerify} data-testid="zk-reset-verify">
          Vérifier avec GitHub
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
        setError("Vérification expirée — réessayez.");
        clearZkReauthProof();
      } else if (code === "rate_limited") {
        setError("Trop de réinitialisations — réessayez plus tard.");
      } else {
        setError("Échec de la réinitialisation. Réessayez.");
      }
      setBusy(false);
    }
  }

  return (
    <ZkGateDialog title="Confirmer la réinitialisation" testId="zk-reset-execute">
      <p className="text-sm text-muted-foreground">
        GitHub vérifié. Supprimer toutes vos données chiffrées et définir une nouvelle passphrase ?
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
          Annuler
        </Button>
        <Button
          type="button"
          variant="destructive"
          loading={busy}
          onClick={onConfirm}
          data-testid="zk-reset-confirm"
        >
          Réinitialiser et recommencer
        </Button>
      </div>
    </ZkGateDialog>
  );
}
