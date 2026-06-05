import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphQLError, fetchIssueDeps, ghGraphql } from "./graphql";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function makeFetchMock(response: {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: response.json ?? (() => Promise.resolve({})),
    text: response.text ?? (() => Promise.resolve("")),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ghGraphql — Authorization + User-Agent headers
// ---------------------------------------------------------------------------

describe("ghGraphql — request headers", () => {
  it("sends Authorization: Bearer <token>", async () => {
    const mockFetch = makeFetchMock({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { result: 1 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await ghGraphql("query { viewer { login } }", {}, "gh-token-abc");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer gh-token-abc");
  });

  it("sends User-Agent: roxabi-live-worker", async () => {
    const mockFetch = makeFetchMock({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {} }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await ghGraphql("query { viewer { login } }", {}, "any-token");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("roxabi-live-worker");
  });
});

// ---------------------------------------------------------------------------
// ghGraphql — GraphQL-level errors
// ---------------------------------------------------------------------------

describe("ghGraphql — GraphQL errors", () => {
  it("throws GraphQLError when body contains an errors key", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ errors: [{ message: "boom" }] }),
      }),
    );

    await expect(
      ghGraphql("query { viewer { login } }", {}, "token"),
    ).rejects.toThrow(GraphQLError);

    await expect(
      ghGraphql("query { viewer { login } }", {}, "token"),
    ).rejects.toThrow(/GraphQL errors/);
  });
});

// ---------------------------------------------------------------------------
// ghGraphql — auth errors → isAuth = true
// ---------------------------------------------------------------------------

describe("ghGraphql — auth errors", () => {
  it("throws GraphQLError with isAuth=true on HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({ ok: false, status: 401 }),
    );

    let caught: unknown;
    try {
      await ghGraphql("query { viewer { login } }", {}, "bad-token");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).isAuth).toBe(true);
  });

  it("throws GraphQLError with isAuth=true on HTTP 403", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({ ok: false, status: 403 }),
    );

    let caught: unknown;
    try {
      await ghGraphql("query { viewer { login } }", {}, "bad-token");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).isAuth).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ghGraphql — happy path
// ---------------------------------------------------------------------------

describe("ghGraphql — happy path", () => {
  it("returns the parsed body on a successful 200 response", async () => {
    const payload = { data: { viewer: { login: "roxabi" } }, rateLimit: { cost: 1 } };
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
      }),
    );

    const result = await ghGraphql("query { viewer { login } }", {}, "token");
    expect(result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// fetchIssueDeps — mapping
// ---------------------------------------------------------------------------

describe("fetchIssueDeps — mapping", () => {
  it("maps blockedBy and blocking nodes to owner/repo#N keys", async () => {
    const issuePayload = {
      data: {
        repository: {
          issue: {
            number: 10,
            blockedBy: {
              nodes: [
                { number: 5, repository: { nameWithOwner: "Roxabi/roxabi-live" } },
              ],
            },
            blocking: {
              nodes: [
                { number: 20, repository: { nameWithOwner: "Roxabi/other-repo" } },
                { number: 21, repository: { nameWithOwner: "Roxabi/other-repo" } },
              ],
            },
          },
        },
      },
    };

    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        ok: true,
        status: 200,
        json: () => Promise.resolve(issuePayload),
      }),
    );

    const result = await fetchIssueDeps("Roxabi", "roxabi-live", 10, "token");
    expect(result).toEqual({
      blocked_by: ["Roxabi/roxabi-live#5"],
      blocking: ["Roxabi/other-repo#20", "Roxabi/other-repo#21"],
    });
  });

  it("returns empty arrays when the issue node is null", async () => {
    const nullPayload = {
      data: {
        repository: {
          issue: null,
        },
      },
    };

    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        ok: true,
        status: 200,
        json: () => Promise.resolve(nullPayload),
      }),
    );

    const result = await fetchIssueDeps("Roxabi", "roxabi-live", 999, "token");
    expect(result).toEqual({ blocked_by: [], blocking: [] });
  });
});
