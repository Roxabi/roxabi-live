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

import { ghGraphql } from "./graphql";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true } as Response));
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
  });

  it("returns true when repository id is present and public API confirms", async () => {
    vi.mocked(ghGraphql).mockResolvedValueOnce({
      data: { repository: { id: "R_kgDO" } },
    });
    await expect(isRepoResolvable("token", "Roxabi/roxabi-live")).resolves.toBe(true);
  });

  it("returns false for public ghosts GraphQL still lists", async () => {
    vi.mocked(ghGraphql).mockResolvedValueOnce({
      data: { repository: { id: "R_ghost" } },
    });
    vi.mocked(fetch).mockResolvedValueOnce({ status: 404, ok: false } as Response);
    await expect(isRepoResolvable("token", "Roxabi/gone", { isPrivate: false })).resolves.toBe(
      false,
    );
  });

  it("skips public API cross-check for private repos", async () => {
    vi.mocked(ghGraphql).mockResolvedValueOnce({
      data: { repository: { id: "R_private" } },
    });
    await expect(isRepoResolvable("token", "Roxabi/secret", { isPrivate: true })).resolves.toBe(
      true,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("filterResolvableRepos", () => {
  it("partitions kept vs dropped", async () => {
    vi.mocked(ghGraphql)
      .mockResolvedValueOnce({ data: { repository: { id: "1" } } })
      .mockRejectedValueOnce(new GraphQLError("Could not resolve to a Repository"));
    const result = await filterResolvableRepos("token", [
      { repo: "Roxabi/ok", isPrivate: false },
      { repo: "Roxabi/gone", isPrivate: false },
    ]);
    expect(result.kept).toEqual([{ repo: "Roxabi/ok", isPrivate: false }]);
    expect(result.dropped).toEqual(["Roxabi/gone"]);
  });
});
