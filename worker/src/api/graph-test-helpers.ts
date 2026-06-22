import type { FakeResult } from "../test-utils";

export function aggregateRepoActivity(
  issues: Array<{ repo: string; updated_at?: string | null }>,
): FakeResult[] {
  const byRepo = new Map<string, { issue_count: number; last_updated_at: string | null }>();
  for (const issue of issues) {
    const prev = byRepo.get(issue.repo);
    const updatedAt = issue.updated_at ?? null;
    if (!prev) {
      byRepo.set(issue.repo, { issue_count: 1, last_updated_at: updatedAt });
      continue;
    }
    prev.issue_count += 1;
    if (updatedAt && (!prev.last_updated_at || updatedAt > prev.last_updated_at)) {
      prev.last_updated_at = updatedAt;
    }
  }
  return [...byRepo.entries()].map(([repo, stats]) => ({ repo, ...stats }));
}
