import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphQLError } from "./graphql";
import { filterResolvableRepos, isRepoResolvable, parseRepoSlug } from "./repo-probe";

vi.mock("./graphql", () => ({
  ghGraphql: vi.fn(),
  GraphQLError: class GraphQLError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "GraphQLError";
    }
  },
}));

vi.mock("./queries", () => ({
  pickRepoBundleQuery: () => "REPO_BUNDLE_QUERY_STRUCTURE_ONLY",
}));

import { ghGraphql } from "./graphql";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true } as Response));
  vi.mocked(ghGraphql).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRepoSlug", () => {
  it("splits owner/name", () => {
    expect(parseRepoSlug("Roxabi/roxabi-live")).toEqual({
      owner: "Roxabi",
      name: "roxabi-live",
    });
  });
});

describe("isRepoResolvable", () => {
  it("returns false on GraphQL NOT_FOUND", async () => {
    vi.mocked(ghGraphql).mockRejectedValueOnce(
      new GraphQLError('GraphQL errors: [{"type":"NOT_FOUND"}]'),
    );
    await expect(isRepoResolvable("token", "Roxabi/gone")).resolves.toBe(false);
    expect(ghGraphql).toHaveBeenCalledWith(
      "REPO_BUNDLE_QUERY_STRUCTURE_ONLY",
      expect.objectContaining({ owner: "Roxabi", name: "gone" }),
      "token",
    );
  });

  it("returns true when bundle query resolves the repository", async () => {
    vi.mocked(ghGraphql).mockResolvedValueOnce({
      data: { repository: { id: "R_kgDO" } },
    });
    await expect(isRepoResolvable("token", "Roxabi/roxabi-live")).resolves.toBe(true);
  });
});

describe("filterResolvableRepos", () => {
  it("partitions kept vs dropped", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const target = String(input);
      if (target.includes("gone")) return { status: 404, ok: false } as Response;
      return { status: 200, ok: true } as Response;
    });
    vi.mocked(ghGraphql).mockResolvedValue({ data: { repository: { id: "1" } } });
    const result = await filterResolvableRepos("token", [
      { repo: "Roxabi/ok", isPrivate: false },
      { repo: "Roxabi/gone", isPrivate: false },
    ]);
    expect(result.kept).toEqual([{ repo: "Roxabi/ok", isPrivate: false }]);
    expect(result.dropped).toEqual(["Roxabi/gone"]);
    expect(ghGraphql).toHaveBeenCalledTimes(1);
  });
});
