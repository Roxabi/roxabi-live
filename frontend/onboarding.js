// onboarding.js — 3-step onboarding progress (GitHub → install → sync)

/** @typedef {'github' | 'install' | 'consent' | 'sync'} OnboardingStep */

export const ONBOARDING_STEPS = [
  { id: "github", label: "Connexion GitHub" },
  { id: "install", label: "Installation" },
  { id: "sync", label: "Synchronisation" },
];

/**
 * Render step progress. Maps consent onto install→sync handoff (step 2 done, prep step 3).
 * @param {OnboardingStep} active
 * @returns {string}
 */
export function renderOnboardingSteps(active) {
  const activeIdx = active === "consent" ? 1 : ONBOARDING_STEPS.findIndex((s) => s.id === active);

  const items = ONBOARDING_STEPS.map((step, i) => {
    const done = i < activeIdx;
    const current = i === activeIdx || (active === "consent" && i === 1);
    const state = done ? "done" : current ? "active" : "pending";
    const marker = done ? "✓" : String(i + 1);
    return `<li class="onboarding-step onboarding-step--${state}" aria-current="${current ? "step" : "false"}">
      <span class="onboarding-step-marker" aria-hidden="true">${marker}</span>
      <span class="onboarding-step-label">${step.label}</span>
    </li>`;
  }).join("");

  return `<nav class="onboarding-steps" aria-label="Progression de l'installation">
    <ol>${items}</ol>
  </nav>`;
}
