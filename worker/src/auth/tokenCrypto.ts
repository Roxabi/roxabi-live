/**
 * AES-GCM token encryption/decryption using the Web Crypto API.
 *
 * Compatible with Cloudflare Workers runtime and the Vitest test environment.
 * Never logs or surfaces plaintext tokens.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode an ArrayBuffer as base64url (no padding, URL-safe chars).
 * Reuses the same approach as b64url in jwt.ts.
 */
function toBase64url(buf: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a base64url string to Uint8Array.
 */
function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import a base64-encoded 32-byte raw key as an AES-GCM CryptoKey.
 *
 * @param b64 - Standard base64 (not base64url) encoding of the 32-byte DEK.
 * @returns A non-extractable CryptoKey usable for encrypt and decrypt.
 */
export async function importDek(b64: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.byteLength !== 32) {
    throw new Error(
      `INSTALL_TOKEN_KEY must decode to exactly 32 bytes (AES-256), got ${bytes.byteLength}`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a plaintext token using AES-GCM with a random 12-byte IV.
 *
 * @param dek       - CryptoKey returned by importDek.
 * @param plaintext - The plaintext installation access token to encrypt.
 * @returns `{ enc, iv }` — both are base64url-encoded (no +, /, = chars).
 */
export async function encryptToken(
  dek: CryptoKey,
  plaintext: string,
): Promise<{ enc: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dek, encoded);
  return {
    enc: toBase64url(ct),
    iv: toBase64url(iv.buffer),
  };
}

/**
 * Decrypt an AES-GCM ciphertext back to plaintext.
 *
 * Propagates the rejection from crypto.subtle.decrypt on authentication failure
 * (tampered ciphertext, wrong DEK). Never swallows errors.
 *
 * @param dek - CryptoKey returned by importDek.
 * @param enc - base64url-encoded ciphertext (from encryptToken).
 * @param iv  - base64url-encoded 12-byte IV (from encryptToken).
 * @returns The original plaintext string.
 * @throws If decryption fails (authentication tag mismatch, wrong key, etc.)
 */
export async function decryptToken(
  dek: CryptoKey,
  enc: string,
  iv: string,
): Promise<string> {
  const ctBytes = fromBase64url(enc);
  const ivBytes = fromBase64url(iv);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    dek,
    ctBytes,
  );
  return new TextDecoder().decode(plainBuffer);
}
