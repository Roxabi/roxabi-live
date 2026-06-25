/**
 * useDecryptedGraph — the dashboard's data hook when ZK is on. Replaces the raw
 * useGraphData: fetches /api/graph, decrypts each node's redacted title with the
 * unlocked accountKey (applyZkDecryption on a disposable clone), then annotates.
 * Ported from the loadAndRender + ensureAccountKeySealing + syncZkContentFromGitHub
 * + refreshZkTitles dance in frontend/app.js.
 *
 * Mounts only inside ZkGate's unlocked branch, so titles never render "(locked)".
 * Re-runs on every lock-state bump (useZkSession version) — e.g. a passphrase
 * change that rotates the session key.
 */

import { GRAPH_QUERY_KEY } from "@/hooks/useGraphData";
import { apiFetch } from "@/lib/api";
import {
  type AnnotatedNode,
  type GraphEdge,
  type GraphResponse,
  type RepoSummary,
  annotateNodes,
} from "@roxabi-live/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useZkRuntime, useZkSession } from "./ZkSessionProvider";
import { getGithubUserToken } from "./github";
import {
  applyZkDecryption,
  ensureAccountKeySealing,
  isZkMigrationIncomplete,
  syncZkContentFromGitHub,
} from "./sync";

export function useDecryptedGraph() {
  const { githubLogin, zkAccountKeyEnabled } = useZkRuntime();
  const { unlocked, version } = useZkSession();

  const query = useQuery({
    queryKey: GRAPH_QUERY_KEY,
    queryFn: () => apiFetch<GraphResponse>("/api/graph"),
  });
  const data = query.data;

  const [nodes, setNodes] = useState<AnnotatedNode[] | null>(null);
  const [sealTick, setSealTick] = useState(0);
  const [needsGithubLink, setNeedsGithubLink] = useState(false);
  const sealedFor = useRef<GraphResponse | null>(null);

  // Decrypt → annotate whenever the graph, the lock state, or a fresh seal lands.
  // version/sealTick are intentional re-run triggers (the body reads neither).
  // biome-ignore lint/correctness/useExhaustiveDependencies: version + sealTick are deliberate re-decrypt signals.
  useEffect(() => {
    if (!data) {
      setNodes(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const clones = data.nodes.map((n) => ({ ...n }));
      await applyZkDecryption(clones, githubLogin, { accountKeyMode: zkAccountKeyEnabled });
      const annotated = annotateNodes(clones, data.edges);
      if (!cancelled) setNodes(annotated);
    })();
    return () => {
      cancelled = true;
    };
  }, [data, version, sealTick, githubLogin, zkAccountKeyEnabled]);

  // Seal-on-enable: persist any unsealed titles (accountKey v2) + pull GitHub
  // content when a user token is linked. Once per fetched graph; bumps sealTick
  // to re-decrypt when new ciphertext rows were written. Best-effort.
  useEffect(() => {
    if (!unlocked || !zkAccountKeyEnabled || !data) return;
    if (sealedFor.current === data) return;
    sealedFor.current = data;
    let cancelled = false;
    (async () => {
      try {
        const clones = data.nodes.map((n) => ({ ...n }));
        const sealResult = await ensureAccountKeySealing(githubLogin, clones);
        let changed = (sealResult?.sealed ?? 0) > 0;
        // needsGithubLink: titles stayed "(sealed)" because no GitHub user token
        // is linked to pull issue content — surface the prompt (legacy
        // showZkGithubLinkNotice). Mirrors frontend/app.js init.
        if (!cancelled && sealResult?.needsGithubLink) setNeedsGithubLink(true);
        if (getGithubUserToken()) {
          const { synced } = await syncZkContentFromGitHub(clones, githubLogin);
          if (synced > 0) changed = true;
        }
        if (changed && !cancelled) setSealTick((t) => t + 1);
      } catch {
        /* sealing/sync is best-effort — titles fall back to "(sealed)" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, unlocked, zkAccountKeyEnabled, githubLogin]);

  return {
    ...query,
    nodes: nodes ?? [],
    edges: (data?.edges ?? []) as GraphEdge[],
    repos: (data?.repos ?? []) as RepoSummary[],
    // Hold "loading" through the first decrypt so titles never flash redacted.
    isLoading: query.isLoading || (Boolean(data) && nodes === null),
    needsGithubLink,
    // Re-read each render; sealTick state change after a migration re-evaluates it.
    zkMigrationIncomplete: isZkMigrationIncomplete(),
  };
}
