/**
 * Auth mutations — consent, tenant switch, install-link polling, logout.
 * Ported from frontend/auth.js (renderConsentGate / renderOrgPicker /
 * pollInstallRefresh / signOut). Each refreshes the cached /api/me on success.
 */

import { ApiError, apiFetch } from "@/lib/api";
import type { MePayload } from "@roxabi-live/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ME_QUERY_KEY } from "./useMe";

/** POST /api/consent — persist operator-read acknowledgement (returns fresh me). */
export function useConsent() {
  const qc = useQueryClient();
  return useMutation<MePayload, ApiError, void>({
    mutationFn: () => apiFetch<MePayload>("/api/consent", { method: "POST" }),
    onSuccess: (me) => {
      qc.setQueryData(ME_QUERY_KEY, me);
    },
  });
}

/** POST /api/active-tenant — switch the active installation, then reload. */
export function useActiveTenant() {
  return useMutation<{ active_tenant_id: number }, ApiError, number>({
    mutationFn: (tenant_id) =>
      apiFetch<{ active_tenant_id: number }>("/api/active-tenant", {
        method: "POST",
        body: { tenant_id },
      }),
    onSuccess: () => {
      window.location.reload();
    },
  });
}

export interface InstallRefreshResult {
  status: "linked" | "choose_tenant" | "pending";
  onboarding_step?: MePayload["onboarding_step"];
  oauth_fallback?: string;
}

/**
 * POST /api/install/refresh — link a freshly-created GitHub App install without
 * a full re-OAuth. Returns 202 (status:"pending") while the webhook is in
 * flight; a single call here, polled by the caller (InstallGate).
 */
export async function installRefresh(): Promise<InstallRefreshResult> {
  const res = await fetch("/api/install/refresh", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) throw new ApiError(401, "unauthorized");
  if (res.status === 202) {
    const body = (await res.json().catch(() => ({}))) as {
      oauth_fallback?: string;
      retry_after_ms?: number;
    };
    return { status: "pending", oauth_fallback: body.oauth_fallback };
  }
  if (!res.ok) throw new ApiError(res.status, `/api/install/refresh ${res.status}`);
  return (await res.json()) as InstallRefreshResult;
}

/** POST /logout — revoke the session, then land on the neutral sign-in screen. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, { to?: string } | undefined>({
    mutationFn: async () => {
      await apiFetch<null>("/logout", { method: "POST" }).catch(() => null);
    },
    onSuccess: (_data, vars) => {
      qc.clear();
      // Default to /sign-in (a neutral SignInScreen). Landing on "/" would let
      // AuthGate read the now-revoked session as a 401 and flash the alarming
      // "Session expired" banner — wrong after a deliberate logout.
      window.location.href = vars?.to ?? "/sign-in";
    },
  });
}
