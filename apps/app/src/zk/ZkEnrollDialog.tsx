/**
 * ZkEnrollDialog — onboarding for first-time encryption setup. Ported from
 * frontend/zk-enroll.js showEnrollGate(). On success, enrollAccountKey() loads
 * the accountKey into the module-scope session → unlocked flips → ZkGate swaps
 * to the dashboard (this dialog unmounts). No imperative resolve() needed.
 */

import { useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
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
  const t = useT();
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
      setError(t("zk.enroll.error.tooShort"));
      return;
    }
    if (pass !== confirm) {
      setError(t("zk.enroll.error.mismatch"));
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
          ? t("zk.enroll.error.alreadyEnrolled")
          : (err as Error)?.message || t("zk.enroll.error.generic"),
      );
      setBusy(false);
    }
  }

  return (
    <ZkGateDialog title={t("zk.enroll.title")} testId="zk-enroll-gate">
      <p className="text-sm text-muted-foreground">
        {t("zk.enroll.description")}
      </p>
      <form className="space-y-3" onSubmit={onSubmit}>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">{t("zk.enroll.passphrase.label")}</span>
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
          <span className="text-xs text-muted-foreground">{t("zk.enroll.confirmPassphrase.label")}</span>
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
          <span>{t("zk.enroll.remember.label")}</span>
        </label>
        <ZkFormError message={error} />
        <div className="flex items-center justify-between gap-3 pt-1">
          <Button type="button" variant="ghost" onClick={() => logout.mutate(undefined)}>
            {t("auth.signOut")}
          </Button>
          <Button type="submit" loading={busy} data-testid="zk-enroll-submit">
            {t("zk.enroll.submitButton")}
          </Button>
        </div>
      </form>
    </ZkGateDialog>
  );
}
