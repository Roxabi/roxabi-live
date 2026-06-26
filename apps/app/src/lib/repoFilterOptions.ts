import type { FilterOption } from "@/hooks/useFilterOptions";
import type { AnnotatedNode, RepoSummary } from "@roxabi-live/shared";

const ARCHIVED_SEPARATOR_VALUE = "__repo_archived_sep__";

function repoActivityRank(repo: RepoSummary, nodes: AnnotatedNode[]) {
  if (repo.issue_count != null) {
    return { count: repo.issue_count, updatedAt: repo.last_updated_at ?? "" };
  }
  let count = 0;
  for (const n of nodes) {
    if (n.repo === repo.repo) count++;
  }
  return { count, updatedAt: "" };
}

function compareReposByActivity(a: RepoSummary, b: RepoSummary, nodes: AnnotatedNode[]) {
  const actA = repoActivityRank(a, nodes);
  const actB = repoActivityRank(b, nodes);
  if (actB.count !== actA.count) return actB.count - actA.count;
  if (actB.updatedAt !== actA.updatedAt) return actB.updatedAt.localeCompare(actA.updatedAt);
  return a.repo.localeCompare(b.repo);
}

function sortReposByActivity(repos: RepoSummary[], nodes: AnnotatedNode[]) {
  return [...repos].sort((a, b) => compareReposByActivity(a, b, nodes));
}

function repoToOption(repo: RepoSummary, nodes: AnnotatedNode[]): FilterOption {
  const count =
    repo.issue_count ?? nodes.reduce((n, node) => n + (node.repo === repo.repo ? 1 : 0), 0);
  return {
    kind: "option",
    value: repo.repo,
    label: repo.repo.replace(/^[^/]+\//, ""),
    count,
  };
}

/** Repo facet options: live repos first; selected archived repos after a divider. */
export function buildRepoFilterOptions(
  repoData: RepoSummary[],
  nodes: AnnotatedNode[],
  selectedRepos: string[],
  archivedDividerLabel: string,
): FilterOption[] {
  const selected = new Set(selectedRepos);

  const data: RepoSummary[] =
    repoData.length > 0
      ? repoData
      : [...new Set(nodes.map((n) => n.repo))].map((repo) => ({
          repo,
          archived: false,
          is_private: true,
          issue_count: nodes.filter((n) => n.repo === repo).length,
          last_updated_at: null,
        }));

  const live = sortReposByActivity(
    data.filter((r) => !r.archived),
    nodes,
  );
  const archivedVisible = sortReposByActivity(
    data.filter((r) => r.archived && selected.has(r.repo)),
    nodes,
  );

  const liveOpts = live.map((r) => repoToOption(r, nodes));
  if (archivedVisible.length === 0) return liveOpts;

  const archOpts: FilterOption[] = archivedVisible.map((r) => ({
    ...repoToOption(r, nodes),
    archived: true,
  }));

  return [
    ...liveOpts,
    { kind: "separator", value: ARCHIVED_SEPARATOR_VALUE, label: archivedDividerLabel },
    ...archOpts,
  ];
}