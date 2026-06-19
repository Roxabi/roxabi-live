import { describe, expect, it } from "vitest";
import { captureDb } from "../test-utils";
import {
  d1PayloadTitle,
  isIssueZkSealed,
  loadZkSealedIssueKeys,
  redactIssueTitle,
  scrubIssuePayloads,
} from "./zk";

describe("zk D1 redaction helpers", () => {
  it("d1PayloadTitle returns null for sealed keys", () => {
    const sealed = new Set(["Roxabi/live#1"]);
    expect(d1PayloadTitle("Secret", "Roxabi/live#1", sealed)).toBeNull();
    expect(d1PayloadTitle("Visible", "Roxabi/live#2", sealed)).toBe("Visible");
  });

  it("d1PayloadTitle is the same function reference as redactIssueTitle (no divergence possible)", () => {
    expect(d1PayloadTitle).toBe(redactIssueTitle);
  });

  it("loadZkSealedIssueKeys returns distinct issue_key set", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_payloads")) {
        return [{ issue_key: "A/r#1" }, { issue_key: "B/r#2" }];
      }
      return [];
    });
    const keys = await loadZkSealedIssueKeys(db);
    expect(keys).toEqual(new Set(["A/r#1", "B/r#2"]));
  });

  it("isIssueZkSealed is true when a row exists", async () => {
    const { db } = captureDb((sql) => {
      if (sql.includes("zk_payloads")) return [{ one: 1 }];
      return [];
    });
    expect(await isIssueZkSealed(db, "X/r#9")).toBe(true);
  });

  it("scrubIssuePayloads issues UPDATE per chunk", async () => {
    const { db, stmts } = captureDb(() => []);
    await scrubIssuePayloads(db, ["A/r#1", "B/r#2"]);
    const scrub = stmts().find((s) => s.sql.includes("UPDATE issues SET payload = json_object()"));
    expect(scrub).toBeDefined();
    expect(scrub?.args).toEqual(["A/r#1", "B/r#2"]);
  });
});
