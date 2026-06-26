/**
 * OnboardingSteps — 3-step progress rail (GitHub → install → sync).
 * Ported from frontend/onboarding.js; "consent" maps onto the install→sync
 * handoff (step 2 done, step 3 prepped).
 */

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

type Active = "github" | "install" | "consent" | "sync";

const STEPS = [
  { id: "github", key: "auth.onboarding.step.github" as const },
  { id: "install", key: "auth.onboarding.step.install" as const },
  { id: "sync", key: "auth.onboarding.step.sync" as const },
] as const;

export function OnboardingSteps({ active }: { active: Active }) {
  const t = useT();
  const activeIdx = active === "consent" ? 1 : STEPS.findIndex((s) => s.id === active);

  return (
    <nav aria-label={t("auth.onboarding.navAriaLabel")} className="mb-6">
      <ol className="flex items-center gap-2 text-sm">
        {STEPS.map((step, i) => {
          const done = i < activeIdx;
          const current = i === activeIdx || (active === "consent" && i === 1);
          const marker = done ? "✓" : String(i + 1);
          return (
            <li
              key={step.id}
              aria-current={current ? "step" : "false"}
              className="flex items-center gap-2"
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                  done && "border-ready bg-ready/15 text-ready",
                  current && "border-primary bg-primary/15 text-primary",
                  !done && !current && "border-border text-muted-foreground",
                )}
                aria-hidden
              >
                {marker}
              </span>
              <span className={cn(current ? "text-foreground" : "text-muted-foreground")}>
                {t(step.key)}
              </span>
              {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
