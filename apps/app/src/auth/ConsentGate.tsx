/**
 * ConsentGate — onboarding_step === "consent".
 * Operator-read acknowledgement before the first sync. POST /api/consent
 * advances the user to "ready". Ported from frontend/auth.js renderConsentGate;
 * Radix Dialog supplies the focus trap the vanilla version hand-rolled.
 */

import { OnboardingSteps } from "@/auth/OnboardingSteps";
import { useConsent, useLogout } from "@/auth/useAuthMutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import type { MePayload } from "@roxabi-live/shared";

export function ConsentGate({ me }: { me: MePayload }) {
  const t = useT();
  const consent = useConsent();
  const logout = useLogout();

  const SCOPES = [
    t("auth.consent.scope.issues"),
    t("auth.consent.scope.repoMeta"),
    t("auth.consent.scope.d1"),
  ];

  return (
    <Dialog open>
      <DialogContent showClose={false} className="max-w-xl">
        <OnboardingSteps active="consent" />
        <DialogTitle className="text-xl font-semibold text-foreground">
          {t("auth.consent.title")}
        </DialogTitle>
        <p className="text-sm text-muted-foreground">
          {t("auth.consent.description")}
        </p>
        <div className="space-y-1.5">
          {SCOPES.map((scope) => (
            <div
              key={scope}
              className="rounded-md border border-border bg-background/40 px-3 py-2 text-sm text-foreground"
            >
              {scope}
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Connecté en tant que <strong className="text-foreground">{me.user.github_login}</strong>.
          Vous pouvez révoquer l'accès depuis vos{" "}
          <a
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t("auth.consent.githubSettingsLink")}
          </a>
          .
        </p>
        <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
          {t("auth.consent.encryptionNotice")}
        </p>
        {consent.isError && (
          <p className="text-sm text-blocked" role="alert">
            {t("auth.consent.error")}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => logout.mutate(undefined)}
            loading={logout.isPending}
          >
            {t("auth.signout")}
          </Button>
          <Button onClick={() => consent.mutate()} loading={consent.isPending}>
            {t("auth.consent.confirmButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
