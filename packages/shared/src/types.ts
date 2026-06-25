/**
 * types.ts — canonical TypeScript contract for the Worker HTTP API.
 *
 * These interfaces mirror the JSON response shapes emitted by `worker/src/api/*`
 * byte-for-byte (field names + nullability). They are the single source of truth
 * for both apps/app (the SPA fetch client, via TanStack Query) and the future
 * apps/api (Hono Worker, once `worker/` is split out).
 *
 * Each type names its producing handler. Keep in sync when a route changes shape.
 *
 * Note: the graph node/edge types are deliberately named `GraphNode`/`GraphEdge`
 * (not `Node`/`Edge`) to avoid colliding with the DOM lib `Node` global in the
 * browser app.
 */

/** GET /api/version — change-detection token (worker/src/api/version.ts). */
export interface VersionResponse {
  version: string;
}

/** Dev lifecycle state of an issue node (worker/src/api/graph.ts). */
export type DevState = "idle" | "dev" | "pr_open" | "pr_reviewed";

/** A dependency-graph node — one issue. Mirrors worker/src/api/graph.ts `Node`. */
export interface GraphNode {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  state: string;
  dev_state: DevState;
  url: string | null;
  milestone: string | null;
  milestone_code: string | null;
  milestone_name: string | null;
  milestone_sort_key: number;
  labels: string[];
  priority: string | null;
  lane: string | null;
  size: string | null;
  /** Server-side board status string (raw); the client computes the visual
   * status (ready/blocked/running/done) separately — see graph.ts annotateNodes. */
  status: string | null;
  is_stub: boolean;
  assignees: string[];
}

/** A directed dependency edge. Mirrors worker/src/api/graph.ts `Edge`. */
export interface GraphEdge {
  src: string;
  dst: string;
  kind: string;
}

/** Repo registry entry returned alongside the graph (filter-dropdown ordering). */
export interface RepoSummary {
  repo: string;
  archived: boolean;
  is_private: boolean;
  issue_count: number;
  last_updated_at: string | null;
}

/** GET /api/graph response (worker/src/api/graph.ts graphRoute). */
export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  repos: RepoSummary[];
}

/** GET /api/issues — one list row (worker/src/api/issues.ts listIssuesRoute). */
export interface IssueListItem {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  state: string;
  url: string | null;
  labels: string[];
  milestone: string | null;
  is_stub: boolean;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

/** GET /api/issues paginated response. */
export interface IssueListResponse {
  issues: IssueListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** A linked-issue reference inside an issue detail (blocking / blocked_by). */
export interface IssueRef {
  key: string;
  number: number;
  repo: string;
}

/** GET /api/issues/* — single issue detail (worker/src/api/issues.ts getIssueRoute). */
export interface IssueDetail {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  state: string;
  url: string | null;
  labels: string[];
  milestone: string | null;
  is_stub: boolean;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  blocking: IssueRef[];
  blocked_by: IssueRef[];
}

/** GET /api/me — current user + onboarding state (worker/src/api/me.ts MePayload). */
export interface MeUser {
  github_id: number;
  github_login: string;
  zk_opt_in: boolean;
  zk_enrolled: boolean;
  zk_account_key_enabled: boolean;
}

export interface InstallTarget {
  id: number;
  login: string;
  type: string;
}

export interface InstallOption {
  kind: string;
  login?: string;
  url: string;
}

export interface Installation {
  tenant_id: number;
  account_login: string;
  account_type: string;
}

export type OnboardingStep = "install" | "consent" | "ready";

export interface MePayload {
  user: MeUser;
  active_tenant_id: number | null;
  /** @deprecated use onboarding_step */
  install_pending: boolean;
  /** @deprecated use install_options */
  install_targets: InstallTarget[];
  install_options: InstallOption[];
  installations: Installation[];
  onboarding_step: OnboardingStep;
  consent_at: string | null;
}

/** GET /api/sync/status — bootstrap progress (worker/src/sync/bootstrap.ts SyncStatus). */
export interface SyncStatus {
  issue_count: number;
  sync_running: boolean;
  /** @deprecated use sync_in_progress */
  initial_sync: boolean;
  repos_total: number;
  repos_synced: number;
  sync_in_progress: boolean;
  sync_halted: boolean;
}

/** GET /api/zk/payloads — one sealed-title row (worker/src/api/zk-payloads.ts). */
export interface ZkPayloadRow {
  issue_key: string;
  pubkey_fp: string;
  key_fp: string | null;
  encrypted_payload: string;
  updated_at: string;
}

export interface ZkPayloadsResponse {
  payloads: ZkPayloadRow[];
}

/** GET /api/zk/key-backup — passphrase-wrapped account key (worker/src/api/zk-key-backup.ts). */
export interface ZkKeyBackup {
  backup_version: number;
  kdf_alg: string;
  kdf_params: string;
  wrap_iv: string;
  wrapped_key: string;
  key_fp: string;
  created_at: string;
  updated_at: string;
}
