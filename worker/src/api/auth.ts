/**
 * Defense-in-depth auth helpers for /admin/* endpoints (#123).
 *
 * Strategy: shared ADMIN_TOKEN secret compared via constant-time comparison
 * to prevent timing-based token enumeration. The token is optional — when
 * ADMIN_TOKEN is unset or empty, the Worker-side gate is bypassed entirely
 * so that the Cloudflare Access edge (Email-OTP) remains the sole guard.
 * Set via `wrangler secret put ADMIN_TOKEN` to enable the Worker-side gate.
 */

/**
 * Constant-time string comparison.
 *
 * Avoids early-return on first mismatching byte by accumulating a XOR
 * result across all character codes. Length difference is encoded into the
 * accumulator rather than short-circuiting so the function always iterates
 * max(a.length, b.length) times.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  // Length mismatch feeds into the accumulator (never short-circuits).
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    // Out-of-bounds chars produce undefined → 0 via bitwise OR.
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * Checks the `Authorization: Bearer <token>` header against ADMIN_TOKEN.
 *
 * Returns `null` when the request is authorized (or the gate is disabled),
 * or a `Response` with 401 JSON when it is not.
 *
 * Safe-when-unset: if adminToken is falsy, this function returns null
 * (gate disabled — edge-Access-only mode).
 */
export function checkAdminAuth(
  request: Request,
  adminToken: string | undefined,
): Response | null {
  // Gate disabled — unset/empty ADMIN_TOKEN means edge Access is the only guard.
  if (!adminToken) return null;

  const authHeader = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  const supplied =
    authHeader.startsWith(prefix) ? authHeader.slice(prefix.length) : "";

  if (timingSafeEqual(supplied, adminToken)) return null;

  return Response.json({ error: "unauthorized" }, { status: 401 });
}
