import { describe, expect, it } from "vitest";
import { captureDb } from "../test-utils";
import { selectWindowedRepos } from "./window";

describe("selectWindowedRepos bootstrap round-robin", () => {
  it("rotates through unsynced repos instead of always picking the first", async () => {
    const allRepos = ["Roxabi/a", "Roxabi/b", "Roxabi/c"];
    let cursor = "0";
    const { db } = captureDb((sql, args) => {
      if (sql.includes("sync_state") && sql.includes("SELECT s.repo")) return [];
      if (sql.includes("SELECT value FROM sync_control") && args[0] === "bootstrap_cursor") {
        return [{ value: cursor }];
      }
      if (sql.includes("INSERT INTO sync_control") && args[0] === "bootstrap_cursor") {
        cursor = String(args[1]);
        return [];
      }
      if (sql.includes("INSERT OR IGNORE INTO sync_control")) return [];
      return [];
    });

    const first = await selectWindowedRepos(db, allRepos, { prioritizeUnsynced: true });
    expect(first.windowedRepos).toEqual(["Roxabi/a"]);

    const second = await selectWindowedRepos(db, allRepos, { prioritizeUnsynced: true });
    expect(second.windowedRepos).toEqual(["Roxabi/b"]);

    const third = await selectWindowedRepos(db, allRepos, { prioritizeUnsynced: true });
    expect(third.windowedRepos).toEqual(["Roxabi/c"]);
  });
});
