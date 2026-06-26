/**
 * Server-owned onboarding step derivation for /api/me and auth flows.
 */

import { type InstallTarget, githubInstallUrl, parseInstallTargets } from "./github-install";
import type { SessionContext } from "./types";

export type OnboardingStep = "install" | "consent" | "ready";

export interface InstallOption {
  kind: "personal" | "org" | "picker";
  login?: string;
  url: string;
}

export function buildInstallOptions(targets: InstallTarget[], appSlug?: string): InstallOption[] {
  const personal = targets.find((t) => t.type === "User");
  const orgs = targets.filter((t) => t.type === "Organization");

  const options: InstallOption[] = [];
  if (personal) {
    options.push({
      kind: "personal",
      login: personal.login,
      url: githubInstallUrl(personal, appSlug),
    });
  }
  for (const org of orgs) {
    options.push({
      kind: "org",
      login: org.login,
      url: githubInstallUrl(org, appSlug),
    });
  }
  if (orgs.length === 0) {
    options.push({ kind: "picker", url: githubInstallUrl(undefined, appSlug) });
  }
  return options;
}

export function deriveOnboardingStep(
  session: SessionContext,
  installations: Array<{ tenant_id: number }>,
  consentAt: string | null,
): OnboardingStep {
  const installPending = session.tenantId == null || installations.length === 0;
  if (installPending) return "install";
  if (!consentAt) return "consent";
  return "ready";
}

export function installTargetsFromUserRow(
  installPending: boolean,
  raw: string | null | undefined,
): InstallTarget[] {
  return installPending ? parseInstallTargets(raw) : [];
}
