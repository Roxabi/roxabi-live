// zk-kdf.js — Argon2id passphrase → AES-GCM wrapping key (#216 PR 3)
import { argon2id } from './vendor/hash-wasm/esm/index.js';

/** Fixed Argon2id parameters — no mobile downgrade (#216 Key Decision #17). */
export const ARGON2_PARAMS = { m: 65536, t: 3, p: 1 };

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}

/**
 * Derive a non-extractable AES-256-GCM wrapping key from passphrase + salt.
 * @param {string} passphrase
 * @param {Uint8Array} salt 16-byte salt
 * @param {{ m: number, t: number, p: number }} params Argon2id params
 * @returns {Promise<CryptoKey>}
 */
export async function deriveWrappingKey(passphrase, salt, params) {
  const raw = await argon2id({
    password: passphrase,
    salt: toBytes(salt),
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  });
  if (raw.byteLength !== 32) throw new Error('KDF output length mismatch');
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}