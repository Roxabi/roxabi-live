/**
 * InstallGate — onboarding_step === "install".
 * Lets the user install the GitHub App (personal / org / picker), auto-detects
 * the new install via /api/install/refresh polling, and offers a manual
 * "I've installed — continue" fallback. Ported from frontend/auth.js
 * (renderInstallCta + autoDetectInstall + pollInstallRefresh).
 */

import { OnboardingSteps } from "@/auth/OnboardingSteps";
import { installRefresh, useLogout } from "@/auth/useAuthMutations";
import { ME_QUERY_KEY } from "@/auth/useMe";
import { Button } from "@/components/ui/button";
import type { InstallOption, MePayload } from "@roxabi-live/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_FALLBACK = "/login?intent=install&redirect=%2Fdashboard";

function optionCopy(opt: InstallOption): { title: string; name: string; hint: string } {
  if (opt.kind === "picker") {
    return {
      title: "Organisation",
      name: "Choisir sur GitHub",
      hint: "GitHub liste les organisations où vous pouvez installer l'app",
    };
  }
  if (opt.kind === "personal") {
    return {
      title: "Compte personnel",
      name: opt.login ?? "",
      hint: "Vos dépôts uniquement — idéal en solo",
    };
  }
  return {
    title: "Organisation",
    name: opt.login ?? "",
    hint: "Installer sur cette org — tous les dépôts ou une sélection sur GitHub",
  };
}

export function InstallGate({ me }: { me: MePayload }) {
  const qc = useQueryClient();
  const logout = useLogout();
  const [checking, setChecking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const cancelled = useRef(false);

  const advanceIfLinked = useCallback(
    (step?: MePayload["onboarding_step"]) => {
      if (step === "consent" || step === "ready") {
        qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
        return true;
      }
      return false;
    },
    [qc],
  );

  // Auto-detect: poll a few times in case the install webhook is still in flight.
  useEffect(() => {
    cancelled.current = false;
    (async () => {
      for (let i = 0; i < 12 && !cancelled.current; i++) {
        try {
          const res = await installRefresh();
          if (res.status !== "pending" && advanceIfLinked(res.onboarding_step)) return;
        } catch {
          return; // 401 / network — user can click Continue
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, [advanceIfLinked]);

  const onContinue = useCallback(async () => {
    setChecking(true);
    setHint(null);
    let fallback = DEFAULT_FALLBACK;
    try {
      for (let i = 0; i < 20; i++) {
        const res = await installRefresh();
        if (res.oauth_fallback) fallback = res.oauth_fallback;
        if (res.status !== "pending" && advanceIfLinked(res.onboarding_step)) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
      setHint(
        `Installation pas encore détectée. Réessayez ou reconnectez-vous via GitHub (${fallback}).`,
      );
    } catch {
      setHint("Session expirée ou erreur réseau — rechargez la page ou reconnectez-vous.");
    } finally {
      setChecking(false);
    }
  }, [advanceIfLinked]);

  const options = me.install_options ?? [];

  return (
    <div className="mx-auto max-w-xl py-12">
      <OnboardingSteps active="install" />
      <div className="space-y-5 rounded-lg border border-border bg-card p-6">
        <h2 className="text-xl font-semibold text-foreground">Installer Roxabi Live sur GitHub</h2>
        <p className="text-sm text-muted-foreground">
          Connecté en tant que <strong className="text-foreground">{me.user.github_login}</strong>{" "}
          (étape&nbsp;1 terminée). Choisissez où installer l'application : compte personnel,
          organisation, ou dépôts sélectionnés uniquement.
        </p>

        <div className="space-y-2">
          {options.map((opt) => {
            const c = optionCopy(opt);
            return (
              <a
                key={`${opt.kind}:${opt.login ?? "picker"}`}
                href={opt.url}
                className="block rounded-md border border-border p-3 transition-colors hover:border-primary hover:bg-card/60"
              >
                <span className="block text-xs uppercase tracking-wide text-muted-foreground">
                  {c.title}
                </span>
                {c.name && <span className="block font-medium text-foreground">{c.name}</span>}
                <span className="block text-xs text-muted-foreground">{c.hint}</span>
              </a>
            );
          })}
          <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            <span className="block font-medium text-foreground">Dépôts sélectionnés</span>
            Choisissez un compte ci-dessus, puis sur GitHub :{" "}
            <strong className="text-foreground">Only select repositories</strong> et sélectionnez
            les dépôts à synchroniser.
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          GitHub vous demandera quels dépôts autoriser, puis vous ramènera ici. Si la redirection
          échoue, revenez et cliquez <strong>J'ai installé — continuer</strong>.
        </p>

        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => logout.mutate({ to: "/" })}
            loading={logout.isPending}
          >
            Se déconnecter
          </Button>
          <Button onClick={onContinue} loading={checking}>
            J'ai installé — continuer
          </Button>
        </div>

        {hint && (
          <p className="text-xs text-blocked" role="alert">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
