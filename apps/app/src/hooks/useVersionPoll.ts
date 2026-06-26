/**
 * useVersionPoll — poll /api/version every 15 s and invalidate the graph query
 * when the corpus version token changes (hourly cron or a mutating webhook
 * bumps it). Mirrors frontend/app.js::fetchVersion. The first observed value is
 * a baseline, not a change, so it never refetches on mount.
 */

import { apiFetch } from "@/lib/api";
import type { VersionResponse } from "@roxabi-live/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { GRAPH_QUERY_KEY } from "./useGraphData";

const VERSION_POLL_MS = 15_000;

export function useVersionPoll(): void {
  const queryClient = useQueryClient();
  const lastSeen = useRef<string | null>(null);

  const { data } = useQuery({
    queryKey: ["version"],
    queryFn: () => apiFetch<VersionResponse>("/api/version"),
    refetchInterval: VERSION_POLL_MS,
  });

  useEffect(() => {
    const version = data?.version;
    if (version == null) return;
    if (lastSeen.current === null) {
      lastSeen.current = version;
      return;
    }
    if (lastSeen.current !== version) {
      lastSeen.current = version;
      void queryClient.invalidateQueries({ queryKey: GRAPH_QUERY_KEY });
    }
  }, [data?.version, queryClient]);
}
