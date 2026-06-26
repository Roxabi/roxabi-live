import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { writeZkAudit } from "./zk-events";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeZkAudit", () => {
  it("logs JSON and no-ops when LOGS is unbound (never throws)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = {} as unknown as Env;

    await expect(
      writeZkAudit(env, {
        event: "zk.backup.enrolled",
        user_id: 7,
        key_fp: "deadbeef12345678",
        backup_version: 1,
        rotation: false,
      }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      prefix: "[zk]",
      event: "zk.backup.enrolled",
      user_id: 7,
      key_fp: "deadbeef12345678",
      backup_version: 1,
      rotation: false,
    });
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("puts audit JSON to R2 when LOGS is bound", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { LOGS: { put } } as unknown as Env;

    await writeZkAudit(env, {
      event: "zk.backup.updated",
      user_id: 3,
      key_fp: "cafebabe",
      backup_version: 2,
      rotation: false,
    });

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = put.mock.calls[0];
    expect(key).toMatch(/^zk\/events\/\d{4}-\d{2}-\d{2}\/.+-zk-backup-updated\.json$/);
    expect(opts).toMatchObject({ httpMetadata: { contentType: "application/json" } });
    const snap = JSON.parse(body as string);
    expect(snap.event).toBe("zk.backup.updated");
    expect(snap.user_id).toBe(3);
  });

  it("swallows R2 put failures (audit must not fail the route)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const put = vi.fn().mockRejectedValue(new Error("R2 down"));
    const env = { LOGS: { put } } as unknown as Env;

    await expect(
      writeZkAudit(env, {
        event: "zk.backup.rotated",
        user_id: 1,
        key_fp: "abcd",
        backup_version: 3,
        rotation: true,
      }),
    ).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(1);
  });
});
