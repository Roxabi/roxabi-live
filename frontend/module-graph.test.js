import { describe, expect, it } from "vitest";

/** Catches broken static imports that prevent app bootstrap (e.g. settings.js). */
describe("module graph", () => {
  it("settings.js loads without import errors", async () => {
    await expect(import("./settings.js")).resolves.toBeDefined();
  });
});
