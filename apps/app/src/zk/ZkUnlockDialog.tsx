/**
 * ZkUnlockDialog — enrolled but locked. Ported from frontend/zk-enroll.js
 * showUnlockGate(). On success the accountKey loads into the session → unlocked
 * flips → ZkGate renders the dashboard. "Mot de passe oublié ?" swaps to the
 * reset warning (zk-reset.js showLostPassphraseWarning).
 */

import { useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { ZkFormError, ZkGateDialog } from "./ZkDialogShell";
import { ZkResetWarningDialog } from "./ZkResetDialog";
import {
  applyZkRememberChoice,
  isZkRememberPreferred,
  setZkRememberPreferred,
  unlockAccountKey,
} from "./enroll";
import { isZkUnlocked } from "./session";

export function ZkUnlockDialog({ login }: { login: string }) {
  const logout = useLogout();
  const [pass, setPass] = useState("");
  const [remember, setRemember] = useState(() => isZkRememberPreferred());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showResetWarning, setShowResetWarning] = useState(false);

  if (showResetWarning) {
    return <ZkResetWarningDialog onCancel={() => setShowResetWarning(false)} />;
  }

  function onRemember(on: boolean) {
    setRemember(on);
    setZkRememberPreferred(on);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await unlockAccountKey(pass, login);
      try {
        await applyZkRememberChoice(login, pass, remember);
      } catch {
        /* remember persistence is best-effort */
      }
      // unlocked flips → ZkGate renders the dashboard.
    } catch {
      if (isZkUnlocked()) return; // a concurrent unlock won the race.
      setError("Passphrase incorrecte. Réessayez.");
      setBusy(false);
    }
  }

  return (
    <ZkGateDialog title="Déverrouiller le chiffrement" testId="zk-unlock-gate">
      <p className="text-sm text-muted-foreground">
        Entrez votre passphrase de chiffrement pour déchiffrer les titres et corps d'issues sur cet
        appareil.
      </p>
      <form className="space-y-3" onSubmit={onSubmit}>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Passphrase</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            data-testid="zk-unlock-pass"
            // biome-ignore lint/a11y/noAutofocus: gate steals focus to the passphrase field by design
            autoFocus
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => onRemember(e.target.checked)}
            data-testid="zk-remember"
            className="size-4"
          />
          <span>Retenir la passphrase sur cet appareil pendant 30 jours</span>
        </label>
        <ZkFormError message={error} />
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => setShowResetWarning(true)}
            data-testid="zk-lost-pass"
          >
            Mot de passe oublié ?
          </Button>
          <div className="flex items-center gap-3">
            <Button type="button" variant="ghost" onClick={() => logout.mutate(undefined)}>
              Se déconnecter
            </Button>
            <Button type="submit" loading={busy} data-testid="zk-unlock-submit">
              Déverrouiller
            </Button>
          </div>
        </div>
      </form>
    </ZkGateDialog>
  );
}
