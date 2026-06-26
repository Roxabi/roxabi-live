import { buildRepoFilterOptions } from "@/lib/repoFilterOptions";
import type { AnnotatedNode, RepoSummary } from "@roxabi-live/shared";
import { describe, expect, it } from "vitest";

const nodes = [] as AnnotatedNode[];

const repos: RepoSummary[] = [
  {
    repo: "Roxabi/live-a",
    archived: false,
    is_private: false,
    issue_count: 10,
    last_updated_at: "2026-06-20T00:00:00Z",
  },
  {
    repo: "Roxabi/live-b",
    archived: false,
    is_private: true,
    issue_count: 5,
    last_updated_at: null,
  },
  {
    repo: "Roxabi/old-vault",
    archived: true,
    is_private: false,
    issue_count: 2,
    last_updated_at: null,
  },
  {
    repo: "Roxabi/legacy",
    archived: true,
    is_private: true,
    issue_count: 1,
    last_updated_at: null,
  },
];

describe("buildRepoFilterOptions", () => {
  it("lists live repos only when registry has no archived repos", () => {
    const liveOnly = repos.filter((r) => !r.archived);
    const opts = buildRepoFilterOptions(liveOnly, nodes, "Archived");
    expect(opts.map((o) => ("kind" in o && o.kind === "separator" ? "|" : o.value))).toEqual([
      "Roxabi/live-a",
      "Roxabi/live-b",
    ]);
  });

  it("appends a divider and all archived repos", () => {
    const opts = buildRepoFilterOptions(repos, nodes, "Archived");
    expect(opts.map((o) => ("kind" in o && o.kind === "separator" ? "sep" : o.value))).toEqual([
      "Roxabi/live-a",
      "Roxabi/live-b",
      "sep",
      "Roxabi/old-vault",
      "Roxabi/legacy",
    ]);
    const archived = opts.find((o) => o.kind !== "separator" && o.value === "Roxabi/old-vault");
    expect(archived && "archived" in archived && archived.archived).toBe(true);
  });
});