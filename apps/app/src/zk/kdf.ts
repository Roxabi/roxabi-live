// kdf.ts — Argon2id passphrase → AES-GCM wrapping key.
// VERBATIM port of frontend/zk-kdf.js (#216 PR 3). Do not alter the parameters
// or derivation: a divergence here silently corrupts every wrapped accountKey.
import { argon2id } from "hash-wasm";

export interface Argon2Params {
  m: number;
  t: number;
  p: number;
}

/** Fixed Argon2id parameters — no mobile downgrade (#216 Key Decision #17). */
export const ARGON2_PARAMS: Argon2Params = { m: 65536, t: 3, p: 1 };

type BufferSource = ArrayBuffer | ArrayBufferView;

function toBytes(buf: BufferSource | Uint8Array): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}

/**
 * Derive a non-extractable AES-256-GCM wrapping key from passphrase + salt.
 */
export async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password: passphrase,
    // TS 5.8 types Uint8Array as Uint8Array<ArrayBufferLike>; hash-wasm's salt
    // wants an ArrayBuffer-backed view. The runtime value always is one.
    salt: toBytes(salt) as Uint8Array<ArrayBuffer>,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: "binary",
  });
  if (raw.byteLength !== 32) throw new Error("KDF output length mismatch");
  return crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
