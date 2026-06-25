import { vi } from "vitest";

vi.mock("./graphql", () => ({
  ghGraphql: vi.fn(),
  GraphQLError: class GraphQLError extends Error {
    isAuth: boolean;
    constructor(msg: string, isAuth = false) {
      super(msg);
      this.isAuth = isAuth;
    }
  },
}));

vi.mock("./queries", () => ({
  ARCHIVED_REPOS_QUERY: "ARCHIVED_REPOS_QUERY",
  ISSUES_QUERY: "ISSUES_QUERY",
  ISSUES_QUERY_STRUCTURE_ONLY: "ISSUES_QUERY_STRUCTURE_ONLY",
  PRS_QUERY: "PRS_QUERY",
  REFS_QUERY: "REFS_QUERY",
  REPO_BUNDLE_QUERY: "REPO_BUNDLE_QUERY",
  REPO_BUNDLE_QUERY_STRUCTURE_ONLY: "REPO_BUNDLE_QUERY_STRUCTURE_ONLY",
  REPOS_QUERY: "REPOS_QUERY",
  STUB_ISSUE_QUERY: "STUB_ISSUE_QUERY",
  STUB_ISSUE_QUERY_STRUCTURE_ONLY: "STUB_ISSUE_QUERY_STRUCTURE_ONLY",
  pickIssuesQuery: (structureOnly: boolean) =>
    structureOnly ? "ISSUES_QUERY_STRUCTURE_ONLY" : "ISSUES_QUERY",
  pickRepoBundleQuery: (structureOnly: boolean) =>
    structureOnly ? "REPO_BUNDLE_QUERY_STRUCTURE_ONLY" : "REPO_BUNDLE_QUERY",
  pickStubIssueQuery: (structureOnly: boolean) =>
    structureOnly ? "STUB_ISSUE_QUERY_STRUCTURE_ONLY" : "STUB_ISSUE_QUERY",
}));

vi.mock("../auth/installToken", () => ({
  getInstallationToken: vi.fn(),
  resolveInstallToken: vi.fn(),
  listInstallationRepos: vi.fn(),
}));

vi.mock("./repo-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repo-probe")>();
  return {
    ...actual,
    filterResolvableRepos: vi.fn(async (_token: string, repos: unknown[]) => ({
      kept: repos,
      dropped: [] as string[],
    })),
    isRepoResolvable: vi.fn().mockResolvedValue(true),
  };
});
