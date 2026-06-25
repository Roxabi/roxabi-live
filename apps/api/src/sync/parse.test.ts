import { describe, expect, it } from "vitest";
import { parseMilestone } from "./parse";

describe("parseMilestone", () => {
  describe("null input", () => {
    it("returns code=null, name=null, sortKey=1000 for null", () => {
      expect(parseMilestone(null)).toEqual({ code: null, name: null, sortKey: 1000 });
    });
  });

  describe("M-number format", () => {
    it("parses M0 em-dash variant", () => {
      expect(parseMilestone("M0 — NATS hardening")).toEqual({
        code: "M0",
        name: "NATS hardening",
        sortKey: 0,
      });
    });

    it("parses M10 em-dash variant", () => {
      expect(parseMilestone("M10 — Social Media")).toEqual({
        code: "M10",
        name: "Social Media",
        sortKey: 10,
      });
    });

    it("parses M1 en-dash variant", () => {
      expect(parseMilestone("M1 – Foundation")).toEqual({
        code: "M1",
        name: "Foundation",
        sortKey: 1,
      });
    });

    it("parses M5 hyphen variant", () => {
      expect(parseMilestone("M5 - Security")).toEqual({
        code: "M5",
        name: "Security",
        sortKey: 5,
      });
    });

    it("trims trailing whitespace from name", () => {
      const result = parseMilestone("M2 — Name with trailing  ");
      expect(result.name).toBe("Name with trailing");
    });

    it("uses numeric value as sortKey for M10", () => {
      const result = parseMilestone("M10 — Social Media");
      expect(result.sortKey).toBe(10);
    });
  });

  describe("Phase format", () => {
    it("parses Phase 0 em-dash variant", () => {
      expect(parseMilestone("Phase 0 — Foundation")).toEqual({
        code: "Ph0",
        name: "Foundation",
        sortKey: 100,
      });
    });

    it("parses Phase 5 em-dash variant", () => {
      expect(parseMilestone("Phase 5 — Security")).toEqual({
        code: "Ph5",
        name: "Security",
        sortKey: 105,
      });
    });

    it("parses Phase 0 en-dash variant", () => {
      expect(parseMilestone("Phase 0 – Foundation")).toEqual({
        code: "Ph0",
        name: "Foundation",
        sortKey: 100,
      });
    });

    it("parses Phase 3 hyphen variant", () => {
      expect(parseMilestone("Phase 3 - Growth")).toEqual({
        code: "Ph3",
        name: "Growth",
        sortKey: 103,
      });
    });

    it("trims trailing whitespace from phase name", () => {
      const result = parseMilestone("Phase 1 — Some Name  ");
      expect(result.name).toBe("Some Name");
    });

    it("uses 100+N as sortKey for Phase N", () => {
      expect(parseMilestone("Phase 5 — Security").sortKey).toBe(105);
    });
  });

  describe("Final Initiatives", () => {
    it('returns code=FIN, name=Final Initiatives, sortKey=999 for "Final Initiatives"', () => {
      expect(parseMilestone("Final Initiatives")).toEqual({
        code: "FIN",
        name: "Final Initiatives",
        sortKey: 999,
      });
    });

    it("handles leading/trailing whitespace around Final Initiatives", () => {
      // raw.trim() === "Final Initiatives" is checked
      expect(parseMilestone("  Final Initiatives  ")).toEqual({
        code: "FIN",
        name: "Final Initiatives",
        sortKey: 999,
      });
    });
  });

  describe("unknown text fallback", () => {
    it("returns code=null, name=raw, sortKey=1000 for unrecognised text", () => {
      expect(parseMilestone("Sprint 1")).toEqual({
        code: null,
        name: "Sprint 1",
        sortKey: 1000,
      });
    });

    it("returns code=null and preserves raw string for empty string", () => {
      expect(parseMilestone("")).toEqual({ code: null, name: "", sortKey: 1000 });
    });

    it("returns code=null for text that does not match M or Phase patterns", () => {
      const result = parseMilestone("Backlog");
      expect(result.code).toBeNull();
      expect(result.sortKey).toBe(1000);
    });
  });
});
