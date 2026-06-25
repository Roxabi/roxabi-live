import { beforeAll, describe, expect, it } from "vitest";
import { importAppPrivateKey, signAppJwt } from "./jwt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a throwaway RSA-2048 key pair (extractable) for use in tests. */
async function generateTestKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

/** Export a private CryptoKey as base64-encoded PKCS#8 DER. */
async function exportPrivateKeyAsB64(key: CryptoKey): Promise<string> {
  const der = (await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer;
  return btoa(String.fromCharCode(...new Uint8Array(der)));
}

/** Convert a base64url string to standard base64 (add padding, swap chars). */
function b64urlToB64(s: string): string {
  return s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
}

// ---------------------------------------------------------------------------
// importAppPrivateKey
// ---------------------------------------------------------------------------

describe("importAppPrivateKey", () => {
  it("imports a base64 PKCS#8 private key and returns a CryptoKey usable for signing", async () => {
    // Arrange
    const pair = await generateTestKeyPair();
    const b64 = await exportPrivateKeyAsB64(pair.privateKey);

    // Act
    const imported = await importAppPrivateKey(b64);

    // Assert — should be a non-extractable CryptoKey with sign usage
    expect(imported).toBeInstanceOf(CryptoKey);
    expect(imported.type).toBe("private");
    expect(imported.extractable).toBe(false);
    expect(imported.usages).toContain("sign");
  });

  it("imported key can actually sign data (round-trip with crypto.subtle.sign)", async () => {
    // Arrange
    const pair = await generateTestKeyPair();
    const b64 = await exportPrivateKeyAsB64(pair.privateKey);
    const imported = await importAppPrivateKey(b64);
    const data = new TextEncoder().encode("test payload");

    // Act — signing must not throw
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", imported, data);

    // Assert — signature has non-zero length (RSA-2048 produces 256 bytes)
    expect(new Uint8Array(sig).length).toBe(256);
  });

  it("imported key can verify against the corresponding public key", async () => {
    // Arrange
    const pair = await generateTestKeyPair();
    const b64 = await exportPrivateKeyAsB64(pair.privateKey);
    const imported = await importAppPrivateKey(b64);
    const data = new TextEncoder().encode("test payload");

    // Act
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", imported, data);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, sig, data);

    // Assert
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signAppJwt — structure
// ---------------------------------------------------------------------------

describe("signAppJwt", () => {
  // Shared key pair for all signing tests
  let privKey: CryptoKey;

  // We generate once (before all) to keep tests fast — key generation is expensive
  beforeAll(async () => {
    const pair = await generateTestKeyPair();
    const b64 = await exportPrivateKeyAsB64(pair.privateKey);
    privKey = await importAppPrivateKey(b64);
  });

  const NOW_SEC = 1_700_000_000;
  const APP_ID = "123456";

  it("produces a JWT with exactly 3 dot-separated parts", async () => {
    // Arrange / Act
    const token = await signAppJwt(APP_ID, privKey, NOW_SEC);

    // Assert
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("header decodes to { alg: 'RS256', typ: 'JWT' }", async () => {
    // Arrange / Act
    const token = await signAppJwt(APP_ID, privKey, NOW_SEC);
    const [headerB64url] = token.split(".");

    // Assert
    const header = JSON.parse(atob(b64urlToB64(headerB64url))) as unknown;
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("payload decodes to { iss, iat: now-60, exp: now+540 }", async () => {
    // Arrange / Act
    const token = await signAppJwt(APP_ID, privKey, NOW_SEC);
    const [, payloadB64url] = token.split(".");

    // Assert
    const payload = JSON.parse(atob(b64urlToB64(payloadB64url))) as unknown;
    expect(payload).toEqual({
      iss: APP_ID,
      iat: NOW_SEC - 60,
      exp: NOW_SEC + 540,
    });
  });

  it("iss equals the appId passed in", async () => {
    // Arrange
    const customId = "987654";
    // Act
    const token = await signAppJwt(customId, privKey, NOW_SEC);
    const [, payloadB64url] = token.split(".");
    const payload = JSON.parse(atob(b64urlToB64(payloadB64url))) as { iss: string };

    // Assert
    expect(payload.iss).toBe(customId);
  });

  it("uses Math.floor(Date.now()/1000) when nowSec is omitted", async () => {
    // Arrange
    const before = Math.floor(Date.now() / 1000);
    // Act
    const token = await signAppJwt(APP_ID, privKey);
    const after = Math.floor(Date.now() / 1000);

    const [, payloadB64url] = token.split(".");
    const payload = JSON.parse(atob(b64urlToB64(payloadB64url))) as { iat: number; exp: number };

    // Assert — iat = now - 60, exp = now + 540; before/after bracket the actual now
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat).toBeLessThanOrEqual(after - 60);
    expect(payload.exp).toBeGreaterThanOrEqual(before + 540);
    expect(payload.exp).toBeLessThanOrEqual(after + 540);
  });
});

// ---------------------------------------------------------------------------
// signAppJwt — base64url encoding (no padding, URL-safe chars)
// ---------------------------------------------------------------------------

describe("signAppJwt base64url encoding", () => {
  let privKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateTestKeyPair();
    const b64 = await exportPrivateKeyAsB64(pair.privateKey);
    privKey = await importAppPrivateKey(b64);
  });

  it("header part contains none of '=', '+', '/'", async () => {
    // Arrange / Act
    const token = await signAppJwt("123456", privKey, 1_700_000_000);
    const [header] = token.split(".");

    // Assert
    expect(header).not.toContain("=");
    expect(header).not.toContain("+");
    expect(header).not.toContain("/");
  });

  it("payload part contains none of '=', '+', '/'", async () => {
    // Arrange / Act
    const token = await signAppJwt("123456", privKey, 1_700_000_000);
    const [, payload] = token.split(".");

    // Assert
    expect(payload).not.toContain("=");
    expect(payload).not.toContain("+");
    expect(payload).not.toContain("/");
  });

  it("signature part contains none of '=', '+', '/'", async () => {
    // Arrange / Act
    const token = await signAppJwt("123456", privKey, 1_700_000_000);
    const [, , sig] = token.split(".");

    // Assert
    expect(sig).not.toContain("=");
    expect(sig).not.toContain("+");
    expect(sig).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// signAppJwt — cryptographic signature verification
// ---------------------------------------------------------------------------

describe("signAppJwt signature verification", () => {
  let privKey: CryptoKey;
  let pubKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateTestKeyPair();
    const b64 = await exportPrivateKeyAsB64(pair.privateKey);
    privKey = await importAppPrivateKey(b64);
    pubKey = pair.publicKey;
  });

  it("crypto.subtle.verify returns true for the signed header.payload", async () => {
    // Arrange
    const token = await signAppJwt("123456", privKey, 1_700_000_000);
    const [headerB64url, payloadB64url, sigB64url] = token.split(".");
    const signingInput = new TextEncoder().encode(`${headerB64url}.${payloadB64url}`);

    // Decode signature from base64url back to bytes
    const sigBytes = Uint8Array.from(atob(b64urlToB64(sigB64url)), (c) => c.charCodeAt(0));

    // Act
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pubKey, sigBytes, signingInput);

    // Assert
    expect(valid).toBe(true);
  });

  it("crypto.subtle.verify returns false when payload is tampered", async () => {
    // Arrange
    const token = await signAppJwt("123456", privKey, 1_700_000_000);
    const [headerB64url, , sigB64url] = token.split(".");

    // Tamper: use a different payload (different iat/exp)
    const tamperedPayload = { iss: "123456", iat: 0, exp: 9_999_999_999 };
    const tamperedPayloadB64url = btoa(JSON.stringify(tamperedPayload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const signingInput = new TextEncoder().encode(`${headerB64url}.${tamperedPayloadB64url}`);

    const sigBytes = Uint8Array.from(atob(b64urlToB64(sigB64url)), (c) => c.charCodeAt(0));

    // Act
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pubKey, sigBytes, signingInput);

    // Assert
    expect(valid).toBe(false);
  });

  it("deleting the signing step (zeroed signature) makes verify return false — negative guard test", async () => {
    // Arrange — build the header.payload manually but use a zeroed-out 256-byte signature
    const headerB64url = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payloadB64url = btoa(
      JSON.stringify({ iss: "123456", iat: 1_699_999_940, exp: 1_700_000_540 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const signingInput = new TextEncoder().encode(`${headerB64url}.${payloadB64url}`);
    const zeroedSig = new Uint8Array(256); // all zeros — not a real RSA signature

    // Act
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pubKey, zeroedSig, signingInput);

    // Assert — a zeroed signature must NOT verify (confirms guard is meaningful)
    expect(valid).toBe(false);
  });
});
