import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRestGet, githubRestHeaders } from "./github-rest";

describe("githubRestHeaders", () => {
  it("includes API version and user agent", () => {
    const headers = githubRestHeaders("tok");
    expect(headers).toMatchObject({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github+json",
      "User-Agent": "roxabi-live-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });
});

describe("githubRestGet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries transient 503 then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const res = await githubRestGet("https://api.github.com/user", "tok", { retries: 1 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});