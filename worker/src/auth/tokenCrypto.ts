/**
 * AES-GCM token encryption/decryption using the Web Crypto API.
 *
 * Compatible with Cloudflare Workers runtime and the Vitest test environment.
 * Never logs or surfaces plaintext tokens.
 */

import { decode, encode } from "./base64url";

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
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
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
    enc: encode(ct),
    iv: encode(iv.buffer),
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
export async function decryptToken(dek: CryptoKey, enc: string, iv: string): Promise<string> {
  const ctBytes = decode(enc);
  const ivBytes = decode(iv);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, dek, ctBytes);
  return new TextDecoder().decode(plainBuffer);
}
