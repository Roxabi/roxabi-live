import { describe, expect, it } from "vitest";
import { checkAdminAuth, timingSafeEqual } from "./auth";

// ── timingSafeEqual ──────────────────────────────────────────────────────

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false when strings differ in content", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("ab", "abc")).toBe(false);
  });

  it("returns false when one string is empty", () => {
    expect(timingSafeEqual("", "abc")).toBe(false);
    expect(timingSafeEqual("abc", "")).toBe(false);
  });
});

// ── checkAdminAuth ───────────────────────────────────────────────────────

const TOKEN = "super-secret-token";

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return new Request("https://example.com/admin/sync", {
    method: "POST",
    headers,
  });
}

describe("checkAdminAuth", () => {
  it("returns null (pass) when ADMIN_TOKEN is unset", () => {
    const result = checkAdminAuth(makeRequest(), undefined);
    expect(result).toBeNull();
  });

  it("returns null (pass) when ADMIN_TOKEN is empty string", () => {
    const result = checkAdminAuth(makeRequest(), "");
    expect(result).toBeNull();
  });

  it("returns null (pass) for correct Bearer token", () => {
    const result = checkAdminAuth(makeRequest(`Bearer ${TOKEN}`), TOKEN);
    expect(result).toBeNull();
  });

  it("returns 401 Response for wrong token", async () => {
    const result = checkAdminAuth(makeRequest("Bearer wrong"), TOKEN);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    const body = await (result as Response).json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("returns 401 Response when Authorization header is missing", async () => {
    const result = checkAdminAuth(makeRequest(), TOKEN);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    const body = await (result as Response).json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("returns 401 for malformed header (no Bearer prefix)", async () => {
    const result = checkAdminAuth(makeRequest(TOKEN), TOKEN);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});
