import "./sync-test-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { writeRunAudit } from "./sync";
import { makeAuditDb, makeRunSyncEnv } from "./sync-run-helpers";

describe("writeRunAudit", () => {
  it("no-ops when LOGS is unbound (never throws)", async () => {
    const env = makeRunSyncEnv({ DB: makeAuditDb() });
    await expect(
      writeRunAudit(env, env.DB, { outcome: "success", stubs: 0, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });

  it("puts a JSON snapshot with counts + watermark when LOGS is bound", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    const db = makeAuditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await writeRunAudit(env, db, { outcome: "success", stubs: 4, durationMs: 1234 });

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = put.mock.calls[0];
    expect(key).toMatch(/^runs\/\d{4}-\d{2}-\d{2}\/.+\.json$/);
    expect(opts).toMatchObject({ httpMetadata: { contentType: "application/json" } });
    const snap = JSON.parse(body as string);
    expect(snap).toMatchObject({
      outcome: "success",
      stubs: 4,
      durationMs: 1234,
      issues: 2650,
      edges: 2432,
      prs: 373,
      watermark: "2026-06-08T09:00:00Z",
      halted: false,
      authFailures: 0,
    });
  });

  it("records net deltas + corrections when before-snapshot + corrections supplied (#80)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    const db = makeAuditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await writeRunAudit(env, db, {
      outcome: "success",
      stubs: 2,
      durationMs: 500,
      before: { issues: 2600, edges: 2400, prs: 370 },
      reposSynced: 8,
      reposSkipped: 1,
      corrections: { stalePrsClosed: 3, staleReposPruned: 1, staleTenantReposRemoved: 2 },
    });

    const snap = JSON.parse(put.mock.calls[0][1] as string);
    expect(snap.deltas).toEqual({ issues: 50, edges: 32, prs: 3 });
    expect(snap.reposSynced).toBe(8);
    expect(snap.reposSkipped).toBe(1);
    expect(snap.corrections).toEqual({
      stubsCreated: 2,
      stalePrsClosed: 3,
      staleReposPruned: 1,
      staleTenantReposRemoved: 2,
    });
  });

  it("emits zero deltas when no before-snapshot is supplied", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    const db = makeAuditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await writeRunAudit(env, db, { outcome: "success", stubs: 0, durationMs: 1 });

    const snap = JSON.parse(put.mock.calls[0][1] as string);
    expect(snap.deltas).toEqual({ issues: 0, edges: 0, prs: 0 });
    expect(snap.corrections).toEqual({
      stubsCreated: 0,
      stalePrsClosed: 0,
      staleReposPruned: 0,
      staleTenantReposRemoved: 0,
    });
  });

  it("swallows R2 put failures (audit must not fail the sync)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const put = vi.fn().mockRejectedValue(new Error("R2 down"));
    const db = makeAuditDb();
    const env = { DB: db, LOGS: { put } } as unknown as Env;

    await expect(
      writeRunAudit(env, db, { outcome: "error", stubs: 0, durationMs: 5 }),
    ).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
