/**
 * ZkEnrollDialog — onboarding for first-time encryption setup. Ported from
 * frontend/zk-enroll.js showEnrollGate(). On success, enrollAccountKey() loads
 * the accountKey into the module-scope session → unlocked flips → ZkGate swaps
 * to the dashboard (this dialog unmounts). No imperative resolve() needed.
 */

import { useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { ZkFormError, ZkGateDialog } from "./ZkDialogShell";
import {
  applyZkRememberChoice,
  enrollAccountKey,
  isZkRememberPreferred,
  setZkRememberPreferred,
} from "./enroll";
import { zkLoginUrl } from "./github";

export function ZkEnrollDialog({ login }: { login: string }) {
  const logout = useLogout();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(() => isZkRememberPreferred());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onRemember(on: boolean) {
    setRemember(on);
    setZkRememberPreferred(on);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pass.length < 8) {
      setError("La passphrase doit comporter au moins 8 caractères.");
      return;
    }
    if (pass !== confirm) {
      setError("Les passphrases ne correspondent pas.");
      return;
    }
    setBusy(true);
    try {
      await enrollAccountKey(pass, login);
      await applyZkRememberChoice(login, pass, remember);
      // Kick off the GitHub token handoff so titles are imported + sealed right
      // away (otherwise they'd stay "(sealed)" until the next login picks up the
      // server auto-handoff). enrollAccountKey() saved a device session, so the
      // post-OAuth return auto-unlocks — no second passphrase prompt.
      window.location.assign(zkLoginUrl(window.location.pathname + window.location.search));
      return;
    } catch (err) {
      const msg = String((err as Error)?.message ?? "");
      setError(
        msg.includes("409")
          ? "Déjà enrôlé — déverrouillez plutôt avec votre passphrase."
          : (err as Error)?.message || "Échec de l'enrôlement. Réessayez.",
      );
      setBusy(false);
    }
  }

  return (
    <ZkGateDialog title="Définir la passphrase de chiffrement" testId="zk-enroll-gate">
      <p className="text-sm text-muted-foreground">
        Choisissez une passphrase pour protéger votre clé de chiffrement. Elle ne quitte jamais ce
        navigateur ; seule une sauvegarde chiffrée est stockée sur le serveur. Cet appareil retient
        votre clé après la configuration — la passphrase sera requise sur d'autres appareils ou
        après un verrouillage.
      </p>
      <form className="space-y-3" onSubmit={onSubmit}>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Passphrase</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            data-testid="zk-enroll-pass"
            // biome-ignore lint/a11y/noAutofocus: gate steals focus to the passphrase field by design
            autoFocus
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Confirmer la passphrase</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="zk-enroll-confirm"
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
        <div className="flex items-center justify-between gap-3 pt-1">
          <Button type="button" variant="ghost" onClick={() => logout.mutate(undefined)}>
            Se déconnecter
          </Button>
          <Button type="submit" loading={busy} data-testid="zk-enroll-submit">
            Créer la sauvegarde
          </Button>
        </div>
      </form>
    </ZkGateDialog>
  );
}
