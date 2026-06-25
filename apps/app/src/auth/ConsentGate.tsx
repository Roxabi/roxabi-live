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
import type { MePayload } from "@roxabi-live/shared";

const SCOPES = [
  "Issues, labels, milestones et relations parent/enfant",
  "Métadonnées des dépôts (nom, visibilité, archivage)",
  "Données stockées dans Cloudflare D1, limitées à votre organisation",
];

export function ConsentGate({ me }: { me: MePayload }) {
  const consent = useConsent();
  const logout = useLogout();

  return (
    <Dialog open>
      <DialogContent showClose={false} className="max-w-xl">
        <OnboardingSteps active="consent" />
        <DialogTitle className="text-xl font-semibold text-foreground">
          Accès aux données
        </DialogTitle>
        <p className="text-sm text-muted-foreground">
          L'application est installée. Avant la première synchronisation, confirmez que Roxabi Live
          peut lire les métadonnées GitHub suivantes :
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
            paramètres GitHub
          </a>
          .
        </p>
        <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
          <strong>Les titres et corps d'issues sont chiffrés côté client avant stockage.</strong> La
          structure du graphe (état, blockers, labels) reste lisible par l'opérateur.
        </p>
        {consent.isError && (
          <p className="text-sm text-blocked" role="alert">
            Enregistrement impossible — vérifiez votre connexion et réessayez.
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => logout.mutate(undefined)}
            loading={logout.isPending}
          >
            Se déconnecter
          </Button>
          <Button onClick={() => consent.mutate()} loading={consent.isPending}>
            J'ai compris — lancer la synchronisation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
