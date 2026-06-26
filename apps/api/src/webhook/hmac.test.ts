import { describe, expect, it } from "vitest";
import { verifyHmac } from "./hmac";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a valid HMAC-SHA256 signature for the given body + secret. */
async function computeHmac(body: ArrayBuffer, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

const BODY_A = new TextEncoder().encode("hello body A").buffer as ArrayBuffer;
const BODY_B = new TextEncoder().encode("tampered body B").buffer as ArrayBuffer;
const SECRET = "test-webhook-secret";

// ---------------------------------------------------------------------------
// verifyHmac
// ---------------------------------------------------------------------------

describe("verifyHmac", () => {
  it("returns false when header is null", async () => {
    // Arrange
    const header = null;
    // Act
    const result = await verifyHmac(BODY_A, header, SECRET);
    // Assert
    expect(result).toBe(false);
  });

  it("returns false when header has wrong prefix (sha1=…)", async () => {
    // Arrange
    const validHex = "a".repeat(64); // 32 bytes hex
    const header = `sha1=${validHex}`;
    // Act
    const result = await verifyHmac(BODY_A, header, SECRET);
    // Assert
    expect(result).toBe(false);
  });

  it("returns false when header has no prefix at all", async () => {
    // Arrange
    const validHex = "a".repeat(64);
    const header = validHex;
    // Act
    const result = await verifyHmac(BODY_A, header, SECRET);
    // Assert
    expect(result).toBe(false);
  });

  it("returns false when hex decodes to fewer than 32 bytes (truncated)", async () => {
    // Arrange — 31 bytes = 62 hex chars
    const header = `sha256=${"ab".repeat(31)}`;
    // Act
    const result = await verifyHmac(BODY_A, header, SECRET);
    // Assert
    expect(result).toBe(false);
  });

  it("returns false when hex decodes to more than 32 bytes", async () => {
    // Arrange — 33 bytes = 66 hex chars
    const header = `sha256=${"ab".repeat(33)}`;
    // Act
    const result = await verifyHmac(BODY_A, header, SECRET);
    // Assert
    expect(result).toBe(false);
  });

  it("returns true for a valid signature computed over the same body + secret", async () => {
    // Arrange
    const header = await computeHmac(BODY_A, SECRET);
    // Act
    const result = await verifyHmac(BODY_A, header, SECRET);
    // Assert
    expect(result).toBe(true);
  });

  it("returns false when body is tampered (valid sig for body A, verified against body B)", async () => {
    // Arrange — signature is correct for BODY_A but body passed is BODY_B
    const header = await computeHmac(BODY_A, SECRET);
    // Act
    const result = await verifyHmac(BODY_B, header, SECRET);
    // Assert
    expect(result).toBe(false);
  });

  it("returns false when signature is tampered (one byte flipped)", async () => {
    // Arrange — compute valid sig then flip first byte
    const validHeader = await computeHmac(BODY_A, SECRET);
    const hexPart = validHeader.slice(7); // strip "sha256="
    // Flip first two hex chars (first byte)
    const firstByte = Number.parseInt(hexPart.slice(0, 2), 16);
    const flipped = ((firstByte + 1) & 0xff).toString(16).padStart(2, "0");
    const tamperedHeader = `sha256=${flipped}${hexPart.slice(2)}`;
    // Act
    const result = await verifyHmac(BODY_A, tamperedHeader, SECRET);
    // Assert
    expect(result).toBe(false);
  });
});
