import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, importDek } from "./tokenCrypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-byte DEK and return it as a base64 string + CryptoKey. */
async function generateDek(): Promise<{ b64: string; key: CryptoKey }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...raw));
  const key = await importDek(b64);
  return { b64, key };
}

/** Decode a base64url string to bytes. */
function decodeBase64url(s: string): Uint8Array {
  // Convert base64url → standard base64, add padding
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Check that a string contains only base64url characters (no +, /, =). */
function isBase64url(s: string): boolean {
  return /^[A-Za-z0-9\-_]+$/.test(s);
}

// ---------------------------------------------------------------------------
// importDek
// ---------------------------------------------------------------------------

describe("importDek", () => {
  it("imports a 32-byte base64 DEK and returns a CryptoKey usable for AES-GCM", async () => {
    // Arrange
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...raw));

    // Act
    const key = await importDek(b64);

    // Assert
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });

  it("rejects a non-32-byte (AES-128 / 16-byte) key with a clear error", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(16));
    const b64 = btoa(String.fromCharCode(...raw));
    await expect(importDek(b64)).rejects.toThrow(/32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// encryptToken / decryptToken — round-trip
// ---------------------------------------------------------------------------

describe("encryptToken / decryptToken", () => {
  it("round-trip: encryptToken then decryptToken returns the original plaintext", async () => {
    // Arrange
    const { key } = await generateDek();
    const plaintext = "ghs_test_github_token_abc123";

    // Act
    const { enc, iv } = await encryptToken(key, plaintext);
    const decrypted = await decryptToken(key, enc, iv);

    // Assert
    expect(decrypted).toBe(plaintext);
  });

  it("IV is 12 bytes (decoded from base64url)", async () => {
    // Arrange
    const { key } = await generateDek();

    // Act
    const { iv } = await encryptToken(key, "some-token");

    // Assert — AES-GCM standard IV length
    const ivBytes = decodeBase64url(iv);
    expect(ivBytes.byteLength).toBe(12);
  });

  it("two encrypts of the same plaintext produce different iv values (random IV)", async () => {
    // Arrange
    const { key } = await generateDek();
    const plaintext = "repeated-token";

    // Act
    const result1 = await encryptToken(key, plaintext);
    const result2 = await encryptToken(key, plaintext);

    // Assert — random IV means each encryption is unique
    expect(result1.iv).not.toBe(result2.iv);
  });

  it("two encrypts of the same plaintext produce different enc values (random IV)", async () => {
    // Arrange
    const { key } = await generateDek();
    const plaintext = "repeated-token";

    // Act
    const result1 = await encryptToken(key, plaintext);
    const result2 = await encryptToken(key, plaintext);

    // Assert — different IV ⇒ different ciphertext
    expect(result1.enc).not.toBe(result2.enc);
  });

  it("tampered ciphertext (flip a char in enc) causes decryptToken to reject/throw", async () => {
    // Arrange
    const { key } = await generateDek();
    const { enc, iv } = await encryptToken(key, "sensitive-token");

    // Tamper: flip the first character of enc
    const tamperedEnc = enc[0] === "A" ? `B${enc.slice(1)}` : `A${enc.slice(1)}`;

    // Act + Assert — AES-GCM authentication tag must fail
    await expect(decryptToken(key, tamperedEnc, iv)).rejects.toThrow();
  });

  it("wrong DEK causes decryptToken to reject/throw", async () => {
    // Arrange
    const { key: key1 } = await generateDek();
    const { key: key2 } = await generateDek();
    const { enc, iv } = await encryptToken(key1, "sensitive-token");

    // Act + Assert — wrong key ⇒ authentication tag mismatch
    await expect(decryptToken(key2, enc, iv)).rejects.toThrow();
  });

  it("enc output is base64url (no '+', '/', '=' chars)", async () => {
    // Arrange
    const { key } = await generateDek();

    // Act
    const { enc } = await encryptToken(key, "test-token-value");

    // Assert
    expect(isBase64url(enc)).toBe(true);
  });

  it("iv output is base64url (no '+', '/', '=' chars)", async () => {
    // Arrange
    const { key } = await generateDek();

    // Act
    const { iv } = await encryptToken(key, "test-token-value");

    // Assert
    expect(isBase64url(iv)).toBe(true);
  });
});
