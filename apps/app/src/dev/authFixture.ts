/**
 * Fixture MePayload shapes for the /dev/auth visual verification route.
 * Mirrors worker/src/api/me.ts MePayload across the onboarding steps.
 */

import type { MePayload } from "@roxabi-live/shared";

function base(): MePayload {
  return {
    user: {
      github_id: 4242,
      github_login: "octofleet",
      zk_opt_in: false,
      zk_enrolled: false,
      zk_account_key_enabled: false,
    },
    active_tenant_id: null,
    install_pending: true,
    install_targets: [],
    install_options: [],
    installations: [],
    onboarding_step: "install",
    consent_at: null,
  };
}

export const fixtureMe: Record<"install" | "consent" | "ready" | "multiTenant", MePayload> = {
  install: {
    ...base(),
    install_options: [
      {
        kind: "personal",
        login: "octofleet",
        url: "https://github.com/apps/roxabi-live/installations/new",
      },
      {
        kind: "org",
        login: "roxabi",
        url: "https://github.com/apps/roxabi-live/installations/new",
      },
    ],
  },
  consent: {
    ...base(),
    active_tenant_id: 1,
    install_pending: false,
    installations: [{ tenant_id: 1, account_login: "roxabi", account_type: "Organization" }],
    onboarding_step: "consent",
  },
  ready: {
    ...base(),
    active_tenant_id: 1,
    install_pending: false,
    installations: [{ tenant_id: 1, account_login: "roxabi", account_type: "Organization" }],
    install_options: [
      {
        kind: "org",
        login: "roxabi",
        url: "https://github.com/apps/roxabi-live/installations/new",
      },
    ],
    onboarding_step: "ready",
    consent_at: "2026-06-25T10:00:00Z",
  },
  multiTenant: {
    ...base(),
    active_tenant_id: 1,
    install_pending: false,
    installations: [
      { tenant_id: 1, account_login: "roxabi", account_type: "Organization" },
      { tenant_id: 2, account_login: "octofleet", account_type: "User" },
    ],
    onboarding_step: "ready",
    consent_at: "2026-06-25T10:00:00Z",
  },
};
