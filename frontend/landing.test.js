import { describe, expect, it } from "vitest";

describe("landing module", () => {
  it("loads without import errors", async () => {
    await expect(import("./landing.js")).resolves.toBeDefined();
  });
});
