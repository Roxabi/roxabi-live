/**
 * useMe — the session/onboarding source of truth (GET /api/me).
 *
 * `retry: false` so a 401 (no session) surfaces immediately as an ApiError with
 * status 401 rather than being retried as a transient failure. The AuthGate
 * reads `error.status === 401` to route the user to sign-in.
 */

import { type ApiError, apiFetch } from "@/lib/api";
import type { MePayload } from "@roxabi-live/shared";
import { useQuery } from "@tanstack/react-query";

export const ME_QUERY_KEY = ["me"] as const;

export function useMe() {
  return useQuery<MePayload, ApiError>({
    queryKey: ME_QUERY_KEY,
    queryFn: () => apiFetch<MePayload>("/api/me"),
    retry: false,
    staleTime: 30_000,
  });
}
