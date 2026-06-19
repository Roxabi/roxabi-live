/**
 * HMAC-SHA256 webhook verification — verbatim port of §4.9 of the CF migration spec.
 *
 * Uses Web Crypto (native in the Workers runtime); no Node.js compat needed.
 * Constant-time comparison via crypto.subtle.verify.
 */

/**
 * Verify a GitHub webhook HMAC-SHA256 signature header.
 *
 * @param body   - Raw request body as ArrayBuffer.
 * @param header - Value of the `X-Hub-Signature-256` header (e.g. "sha256=<hex>").
 * @param secret - HMAC secret configured on the GitHub webhook.
 * @returns true if the signature is valid, false otherwise.
 */
export async function verifyHmac(
  body: ArrayBuffer,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const hexPart = header.slice(7);
  const hexBytes = hexPart.match(/.{2}/g) ?? [];
  if (hexBytes.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = Uint8Array.from(hexBytes.map((b) => Number.parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, sig, body);
}
