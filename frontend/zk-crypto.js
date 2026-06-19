// zk-crypto.js — ECIES P-256 + accountKey AES-GCM (#142 S2, #216 PR 3)
// v1: Ephemeral ECDH-P256 → HKDF-SHA256 → AES-GCM-256
// v2: accountKey (AES-256-GCM) with passphrase-wrapped D1 backup

import { deriveWrappingKey, ARGON2_PARAMS } from './zk-kdf.js';

export { ARGON2_PARAMS };

const DB_NAME = 'roxabi-zk-v1';
const STORE_NAME = 'keypairs';
const META_DB_NAME = 'roxabi-zk-v2';
const META_STORE_NAME = 'account_meta';
const HKDF_INFO = new TextEncoder().encode('roxabi-zk-ecies-v1');
const HKDF_SALT = new Uint8Array(32);

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}

function b64Encode(buf) {
  const bytes = toBytes(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexEncode(buf) {
  return [...toBytes(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexDecode(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function parseEnvelope(envelopeJson) {
  return typeof envelopeJson === 'string' ? JSON.parse(envelopeJson) : envelopeJson;
}

/** Return envelope version (1 = ECIES, 2 = accountKey) or null if unparseable. */
export function parseEnvelopeVersion(envelopeJson) {
  try {
    return parseEnvelope(envelopeJson).v ?? null;
  } catch {
    return null;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(login) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(login);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(login, record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record, login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(login) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function openMetaDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function metaIdbGet(login) {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, 'readonly');
    const req = tx.objectStore(META_STORE_NAME).get(login);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function metaIdbPut(login, record) {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, 'readwrite');
    tx.objectStore(META_STORE_NAME).put(record, login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function metaIdbDelete(login) {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, 'readwrite');
    tx.objectStore(META_STORE_NAME).delete(login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** True when a per-device ECDH key pair exists in IndexedDB. */
export async function hasZkKeyPair(githubLogin) {
  const existing = await idbGet(githubLogin);
  return Boolean(existing?.publicKey && existing?.privateKey);
}

/** Delete legacy ECDH key pair after v1→v2 migration (#216 PR 5). */
export async function deleteZkKeyPair(githubLogin) {
  await idbDelete(githubLogin);
}

/**
 * Persist enrollment metadata only — never raw key or passphrase (#216).
 * @param {{ key_fp: string, enrolled_at: string }} meta
 */
export async function saveAccountMeta(githubLogin, meta) {
  await metaIdbPut(githubLogin, meta);
}

/** @returns {Promise<{ key_fp: string, enrolled_at: string }|null>} */
export async function getAccountMeta(githubLogin) {
  return metaIdbGet(githubLogin);
}

/** Remove enrollment metadata after server-side ZK reset (#216). */
export async function deleteAccountMeta(githubLogin) {
  await metaIdbDelete(githubLogin);
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey', 'deriveBits'],
  );
}

/** SHA-256(SPKI) first 16 bytes as hex — stored alongside ciphertext rows. */
export async function fingerprintPublicKey(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', spki);
  return [...new Uint8Array(hash)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveAesKey(sharedBits) {
  const base = await crypto.subtle.importKey(
    'raw',
    toBytes(sharedBits),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Ensure a per-login ECDH key pair exists in IndexedDB.
 * @returns {{ publicKey: CryptoKey, privateKey: CryptoKey, pubkeyFp: string }}
 */
export async function ensureZkKeyPair(githubLogin) {
  const existing = await idbGet(githubLogin);
  if (existing?.publicKey && existing?.privateKey) {
    const pubkeyFp =
      existing.pubkeyFp ?? (await fingerprintPublicKey(existing.publicKey));
    return { publicKey: existing.publicKey, privateKey: existing.privateKey, pubkeyFp };
  }

  const pair = await generateKeyPair();
  const pubkeyFp = await fingerprintPublicKey(pair.publicKey);
  await idbPut(githubLogin, {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    pubkeyFp,
  });
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, pubkeyFp };
}

/** ECIES encrypt plaintext string to envelope JSON. */
export async function eciesEncrypt(publicKey, plaintext) {
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    ephemeral.privateKey,
    256,
  );
  const aesKey = await deriveAesKey(shared);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  );
  const epk = await crypto.subtle.exportKey('raw', ephemeral.publicKey);
  return JSON.stringify({
    v: 1,
    epk: b64Encode(epk),
    iv: b64Encode(iv),
    ct: b64Encode(ct),
  });
}

/** ECIES decrypt envelope JSON to plaintext string. */
export async function eciesDecrypt(privateKey, envelopeJson) {
  const env = JSON.parse(envelopeJson);
  if (env.v !== 1) throw new Error('unsupported envelope version');

  const epkRaw = b64Decode(env.epk);
  const ephemeralPub = await crypto.subtle.importKey(
    'raw',
    epkRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephemeralPub },
    privateKey,
    256,
  );
  const aesKey = await deriveAesKey(shared);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64Decode(env.iv) },
    aesKey,
    b64Decode(env.ct),
  );
  return new TextDecoder().decode(plain);
}

/** Encrypt issue content `{ title, body? }`. */
export async function sealContent(publicKey, content) {
  return eciesEncrypt(publicKey, JSON.stringify(content));
}

/** Decrypt issue content envelope. */
export async function openContent(privateKey, envelopeJson) {
  const plain = await eciesDecrypt(privateKey, envelopeJson);
  return JSON.parse(plain);
}

/** Encrypt issue title payload `{ title }`. */
export async function sealTitle(publicKey, title) {
  return sealContent(publicKey, { title });
}

/** Decrypt issue title from envelope (legacy + content payloads). */
export async function openTitle(privateKey, envelopeJson) {
  const obj = await openContent(privateKey, envelopeJson);
  return obj.title ?? null;
}

// --- accountKey hierarchy (#216) ---

/** Generate a random AES-256-GCM accountKey (extractable for wrapping). */
export async function generateAccountKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

/** SHA-256(rawAccountKey)[0:16] hex — stored in zk_payloads.key_fp / zk_key_backups.key_fp. */
export async function fingerprintAccountKey(accountKey) {
  const raw = await crypto.subtle.exportKey('raw', accountKey);
  return fingerprintAccountKeyRaw(raw);
}

/** Fingerprint from raw 32-byte account key material. */
export async function fingerprintAccountKeyRaw(rawAccountKey) {
  const hash = await crypto.subtle.digest('SHA-256', toBytes(rawAccountKey));
  return hexEncode(new Uint8Array(hash).slice(0, 16));
}

/** Re-import accountKey as non-extractable session key after wrapping. */
export async function sessionAccountKey(accountKey) {
  const raw = await crypto.subtle.exportKey('raw', accountKey);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wrap accountKey with passphrase-derived wrapping key.
 * @returns {{ kdf_alg: string, kdf_params: string, wrap_iv: string, wrapped_key: string, key_fp: string }}
 */
export async function wrapAccountKey(passphrase, accountKey) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await deriveWrappingKey(passphrase, salt, ARGON2_PARAMS);
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const rawAccountKey = await crypto.subtle.exportKey('raw', accountKey);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv },
    wrappingKey,
    rawAccountKey,
  );
  return {
    kdf_alg: 'argon2id',
    kdf_params: JSON.stringify({
      m: ARGON2_PARAMS.m,
      t: ARGON2_PARAMS.t,
      p: ARGON2_PARAMS.p,
      salt: hexEncode(salt),
    }),
    wrap_iv: b64Encode(wrapIv),
    wrapped_key: b64Encode(wrapped),
    key_fp: await fingerprintAccountKeyRaw(rawAccountKey),
  };
}

/**
 * Unwrap accountKey backup blob with passphrase.
 * @param {string} passphrase
 * @param {{ kdf_params: string|object, wrap_iv: string, wrapped_key: string }} backup
 * @returns {Promise<CryptoKey>} non-extractable session accountKey
 */
export async function unwrapAccountKey(passphrase, backup) {
  const blob =
    typeof backup.kdf_params === 'string'
      ? JSON.parse(backup.kdf_params)
      : backup.kdf_params;
  // Pin KDF cost client-side: never trust server-supplied m/t/p (a malicious or
  // compromised operator could return weakened params to make offline
  // brute-force of the passphrase cheap). Only the salt comes from the blob.
  if (
    blob.m !== ARGON2_PARAMS.m ||
    blob.t !== ARGON2_PARAMS.t ||
    blob.p !== ARGON2_PARAMS.p
  ) {
    throw new Error('kdf_param_mismatch');
  }
  const salt = hexDecode(blob.salt);
  const wrappingKey = await deriveWrappingKey(passphrase, salt, ARGON2_PARAMS);
  const rawAccountKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64Decode(backup.wrap_iv) },
    wrappingKey,
    b64Decode(backup.wrapped_key),
  );
  return crypto.subtle.importKey(
    'raw',
    rawAccountKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** v2 envelope encrypt `{ title, body? }` with accountKey. */
export async function sealWithAccountKey(accountKey, content) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    accountKey,
    new TextEncoder().encode(JSON.stringify(content)),
  );
  return JSON.stringify({
    v: 2,
    alg: 'AES-GCM-256',
    iv: b64Encode(iv),
    ct: b64Encode(ct),
  });
}

/** v2 envelope decrypt to `{ title, body? }`. */
export async function openWithAccountKey(accountKey, envelopeJson) {
  const env = parseEnvelope(envelopeJson);
  if (env.v !== 2) throw new Error('unsupported envelope version');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64Decode(env.iv) },
    accountKey,
    b64Decode(env.ct),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Dual-read decrypt: v2 accountKey or v1 ECDH privateKey.
 * @param {{ accountKey?: CryptoKey, privateKey?: CryptoKey }} keys
 */
export async function openContentDual(keys, envelopeJson) {
  const env = parseEnvelope(envelopeJson);
  if (env.v === 2) {
    if (!keys.accountKey) throw new Error('accountKey required for v2 envelope');
    return openWithAccountKey(keys.accountKey, env);
  }
  if (env.v === 1) {
    if (!keys.privateKey) throw new Error('privateKey required for v1 envelope');
    return openContent(keys.privateKey, envelopeJson);
  }
  throw new Error('unsupported envelope version');
}