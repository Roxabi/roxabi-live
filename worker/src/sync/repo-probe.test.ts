import { describe, expect, it, vi } from "vitest";
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

import { ghGraphql } from "./graphql";

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
  });

  it("returns true when repository id is present", async () => {
    vi.mocked(ghGraphql).mockResolvedValueOnce({
      data: { repository: { id: "R_kgDO" } },
    });
    await expect(isRepoResolvable("token", "Roxabi/roxabi-live")).resolves.toBe(true);
  });
});

describe("filterResolvableRepos", () => {
  it("partitions kept vs dropped", async () => {
    vi.mocked(ghGraphql)
      .mockResolvedValueOnce({ data: { repository: { id: "1" } } })
      .mockRejectedValueOnce(new GraphQLError("Could not resolve to a Repository"));
    const result = await filterResolvableRepos("token", [
      { repo: "Roxabi/ok" },
      { repo: "Roxabi/gone" },
    ]);
    expect(result.kept).toEqual([{ repo: "Roxabi/ok" }]);
    expect(result.dropped).toEqual(["Roxabi/gone"]);
  });
});
