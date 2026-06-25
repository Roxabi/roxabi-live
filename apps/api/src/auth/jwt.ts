/**
 * GitHub App JWT signing — RS256 / RSASSA-PKCS1-v1_5 via Web Crypto.
 *
 * Uses only ambient globals (crypto.subtle, TextEncoder, btoa, atob) —
 * no Node.js imports, compatible with both the Cloudflare Workers runtime
 * and the vitest test environment.
 */

import { encode } from "./base64url";

/**
 * Import a base64-encoded PKCS#8 DER private key for use with RS256.
 *
 * @param b64Pkcs8Der - base64 (standard, not base64url) encoding of the PKCS#8 DER bytes.
 * @returns A non-extractable CryptoKey with the "sign" usage.
 */
export async function importAppPrivateKey(b64Pkcs8Der: string): Promise<CryptoKey> {
  const derBytes = Uint8Array.from(atob(b64Pkcs8Der), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    derBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Sign a GitHub App JWT using RS256.
 *
 * @param appId  - GitHub App numeric ID (becomes the `iss` claim).
 * @param key    - Private CryptoKey returned by importAppPrivateKey.
 * @param nowSec - Unix timestamp in seconds (defaults to current time).
 * @returns Compact serialized JWT: `<header>.<payload>.<signature>` (all base64url).
 */
export async function signAppJwt(appId: string, key: CryptoKey, nowSec?: number): Promise<string> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);

  const headerB64 = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payloadB64 = encode(JSON.stringify({ iss: appId, iat: now - 60, exp: now + 540 }));

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signingInput);
  const sigB64 = encode(sigBuffer);

  return `${headerB64}.${payloadB64}.${sigB64}`;
}
