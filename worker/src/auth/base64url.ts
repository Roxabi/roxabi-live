/**
 * base64url helpers — shared between tokenCrypto.ts and jwt.ts.
 *
 * Encoding: no padding, URL-safe chars (+ → -, / → _, strip =).
 * Compatible with Cloudflare Workers runtime and the Vitest test environment
 * (ambient globals: btoa, atob, Uint8Array).
 */

/**
 * Encode a string or ArrayBuffer as base64url (no padding, URL-safe chars).
 * - Strings are encoded directly via btoa (used by jwt.ts for JSON headers/payloads).
 * - ArrayBuffers are converted to a binary string first (used by tokenCrypto.ts for ciphertext/IV).
 */
export function encode(input: string | ArrayBuffer): string {
  let b64: string;
  if (typeof input === "string") {
    b64 = btoa(input);
  } else {
    const bytes = new Uint8Array(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    b64 = btoa(binary);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a base64url string to Uint8Array.
 * Re-adds standard base64 padding before calling atob.
 */
export function decode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
