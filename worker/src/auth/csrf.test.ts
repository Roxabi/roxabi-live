import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AuthEnv } from "./types";
import { requireSameOriginPost } from "./csrf";
import { makeEnv, captureDb } from "../test-utils";

function makeApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.post("/api/mutate", requireSameOriginPost, (c) => c.json({ ok: true }));
  return app;
}

describe("requireSameOriginPost", () => {
  it("allows POST with matching Origin", async () => {
    const { db } = captureDb();
    const res = await makeApp().request(
      "https://live.roxabi.dev/api/mutate",
      {
        method: "POST",
        headers: { Origin: "https://live.roxabi.dev" },
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
  });

  it("rejects POST with mismatched Origin", async () => {
    const { db } = captureDb();
    const res = await makeApp().request(
      "https://live.roxabi.dev/api/mutate",
      {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      },
      makeEnv(db),
    );
    expect(res.status).toBe(403);
  });

  it("allows POST with matching Referer when Origin is absent", async () => {
    const { db } = captureDb();
    const res = await makeApp().request(
      "https://live.roxabi.dev/api/mutate",
      {
        method: "POST",
        headers: { Referer: "https://live.roxabi.dev/dashboard" },
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
  });

  it("rejects POST with mismatched Referer", async () => {
    const { db } = captureDb();
    const res = await makeApp().request(
      "https://live.roxabi.dev/api/mutate",
      {
        method: "POST",
        headers: { Referer: "https://evil.example/phish" },
      },
      makeEnv(db),
    );
    expect(res.status).toBe(403);
  });

  it("allows POST when neither Origin nor Referer is present", async () => {
    const { db } = captureDb();
    const res = await makeApp().request(
      "https://live.roxabi.dev/api/mutate",
      { method: "POST" },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
  });
});