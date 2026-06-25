// crypto.ts — ECIES P-256 + accountKey AES-GCM.
// VERBATIM port of frontend/zk-crypto.js (#142 S2, #216 PR 3). The IndexedDB
// names/versions, HKDF info strings, envelope shapes and KDF params MUST stay
// byte-identical — they address the user's already-encrypted corpus.
//   v1: Ephemeral ECDH-P256 → HKDF-SHA256 → AES-GCM-256
//   v2: accountKey (AES-256-GCM) with passphrase-wrapped D1 backup

import { ARGON2_PARAMS, deriveWrappingKey } from "./kdf";

export { ARGON2_PARAMS };

const DB_NAME = "roxabi-zk-v1";
const STORE_NAME = "keypairs";
const META_DB_NAME = "roxabi-zk-v2";
const META_STORE_NAME = "account_meta";
const DEVICE_STORE_NAME = "device_session";
const REMEMBER_STORE_NAME = "remember_passphrase";
const DEVICE_SECRET_KEY = "roxabi:zk_device_secret";
export const REMEMBER_PASSPHRASE_PREF_KEY = "roxabi:remember_passphrase";
export const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const META_DB_VERSION = 3;
const HKDF_REMEMBER_INFO = new TextEncoder().encode("roxabi-zk-remember-v1");
const HKDF_DEVICE_SESSION_INFO = new TextEncoder().encode("roxabi-zk-device-session-v1");
const HKDF_INFO = new TextEncoder().encode("roxabi-zk-ecies-v1");
const HKDF_SALT = new Uint8Array(32);

type Bytes = ArrayBuffer | ArrayBufferView | Uint8Array;

export interface AccountMeta {
  key_fp: string;
  enrolled_at: string;
}

export interface KeyBackupBlob {
  kdf_params: string | { m: number; t: number; p: number; salt: string };
  wrap_iv: string;
  wrapped_key: string;
}

export interface WrappedAccountKey {
  kdf_alg: string;
  kdf_params: string;
  wrap_iv: string;
  wrapped_key: string;
  key_fp: string;
}

export interface IssueContent {
  // Titles can be sealed null (structure-only sync with no GitHub title); the
  // decrypt side maps null → SEALED_TITLE_LABEL. Mirrors the legacy JS shape.
  title: string | null;
  body?: string | null;
}

// Return types are pinned to Uint8Array<ArrayBuffer> (not the default
// Uint8Array<ArrayBufferLike>) so crypto.subtle's BufferSource params accept
// them under TS 5.8. The runtime values are always ArrayBuffer-backed.
function toBytes(buf: Bytes): Uint8Array<ArrayBuffer> {
  if (buf instanceof Uint8Array) return buf as Uint8Array<ArrayBuffer>;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(buf);
}

function b64Encode(buf: Bytes): string {
  const bytes = toBytes(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64Decode(str: string): Uint8Array<ArrayBuffer> {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexEncode(buf: Bytes): string {
  return [...toBytes(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexDecode(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: envelope is JSON of unknown shape until v-checked
function parseEnvelope(envelopeJson: string | Record<string, any>): Record<string, any> {
  return typeof envelopeJson === "string" ? JSON.parse(envelopeJson) : envelopeJson;
}

/** Return envelope version (1 = ECIES, 2 = accountKey) or null if unparseable. */
export function parseEnvelopeVersion(envelopeJson: string): number | null {
  try {
    return parseEnvelope(envelopeJson).v ?? null;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function idbGet(login: string): Promise<any> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(login);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function idbPut(login: string, record: any): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(login: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function openMetaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB_NAME, META_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(DEVICE_STORE_NAME)) {
        db.createObjectStore(DEVICE_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(REMEMBER_STORE_NAME)) {
        db.createObjectStore(REMEMBER_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function metaIdbGet(login: string): Promise<any> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readonly");
    const req = tx.objectStore(META_STORE_NAME).get(login);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function metaIdbPut(login: string, record: any): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readwrite");
    tx.objectStore(META_STORE_NAME).put(record, login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function metaIdbDelete(login: string): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readwrite");
    tx.objectStore(META_STORE_NAME).delete(login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** True when a per-device ECDH key pair exists in IndexedDB. */
export async function hasZkKeyPair(githubLogin: string): Promise<boolean> {
  const existing = await idbGet(githubLogin);
  return Boolean(existing?.publicKey && existing?.privateKey);
}

/** Delete legacy ECDH key pair after v1→v2 migration (#216 PR 5). */
export async function deleteZkKeyPair(githubLogin: string): Promise<void> {
  await idbDelete(githubLogin);
}

/**
 * Persist enrollment metadata only — never raw key or passphrase (#216).
 */
export async function saveAccountMeta(githubLogin: string, meta: AccountMeta): Promise<void> {
  await metaIdbPut(githubLogin, meta);
}

export async function getAccountMeta(githubLogin: string): Promise<AccountMeta | null> {
  return metaIdbGet(githubLogin);
}

/** Remove enrollment metadata after server-side ZK reset (#216). */
export async function deleteAccountMeta(githubLogin: string): Promise<void> {
  await metaIdbDelete(githubLogin);
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function deviceIdbGet(login: string): Promise<any> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEVICE_STORE_NAME, "readonly");
    const req = tx.objectStore(DEVICE_STORE_NAME).get(login);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function deviceIdbPut(login: string, record: any): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEVICE_STORE_NAME, "readwrite");
    tx.objectStore(DEVICE_STORE_NAME).put(record, login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deviceIdbDelete(login: string): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEVICE_STORE_NAME, "readwrite");
    tx.objectStore(DEVICE_STORE_NAME).delete(login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deriveDeviceSessionKey(): Promise<CryptoKey> {
  const secret = await getDeviceSecret();
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_DEVICE_SESSION_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Persist unlocked accountKey on this device (IndexedDB). Passphrase stays out of
 * storage — only needed on new devices or after explicit Lock / reset.
 */
export async function saveDeviceSession(
  githubLogin: string,
  accountKey: CryptoKey,
  keyFp: string,
): Promise<void> {
  const raw = await crypto.subtle.exportKey("raw", accountKey);
  const key = await deriveDeviceSessionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, raw);
  await deviceIdbPut(githubLogin, {
    v: 2,
    iv: b64Encode(iv),
    ct: b64Encode(ct),
    key_fp: keyFp,
  });
}

export async function loadDeviceSession(
  githubLogin: string,
): Promise<{ accountKey: CryptoKey; key_fp: string } | null> {
  const rec = await deviceIdbGet(githubLogin);
  if (!rec) return null;

  if (rec.v === 2 && rec.ct && rec.key_fp) {
    try {
      const key = await deriveDeviceSessionKey();
      const raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64Decode(rec.iv) },
        key,
        b64Decode(rec.ct),
      );
      const extractable = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const accountKey = await sessionAccountKey(extractable);
      return { accountKey, key_fp: rec.key_fp };
    } catch {
      await deviceIdbDelete(githubLogin);
      return null;
    }
  }

  if (rec.accountKey instanceof CryptoKey && rec.key_fp) {
    return { accountKey: rec.accountKey, key_fp: rec.key_fp };
  }

  await deviceIdbDelete(githubLogin);
  return null;
}

export async function clearDeviceSession(githubLogin: string): Promise<void> {
  await deviceIdbDelete(githubLogin);
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function rememberIdbGet(login: string): Promise<any> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REMEMBER_STORE_NAME, "readonly");
    const req = tx.objectStore(REMEMBER_STORE_NAME).get(login);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: IndexedDB stores arbitrary records
async function rememberIdbPut(login: string, record: any): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REMEMBER_STORE_NAME, "readwrite");
    tx.objectStore(REMEMBER_STORE_NAME).put(record, login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function rememberIdbDelete(login: string): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REMEMBER_STORE_NAME, "readwrite");
    tx.objectStore(REMEMBER_STORE_NAME).delete(login);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getDeviceSecret(): Promise<Uint8Array<ArrayBuffer>> {
  let b64 = localStorage.getItem(DEVICE_SECRET_KEY);
  if (!b64) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    b64 = b64Encode(bytes);
    localStorage.setItem(DEVICE_SECRET_KEY, b64);
  }
  return b64Decode(b64);
}

async function deriveDeviceRememberKey(): Promise<CryptoKey> {
  const secret = await getDeviceSecret();
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_REMEMBER_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-GCM encrypt passphrase for 30-day local auto-unlock (device-bound key). */
export async function saveRememberPassphrase(
  githubLogin: string,
  passphrase: string,
): Promise<void> {
  const key = await deriveDeviceRememberKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(passphrase),
  );
  await rememberIdbPut(githubLogin, {
    iv: b64Encode(iv),
    ct: b64Encode(ct),
    remember_until: new Date(Date.now() + REMEMBER_TTL_MS).toISOString(),
  });
}

/** @returns passphrase or null when absent/expired */
export async function loadRememberPassphrase(githubLogin: string): Promise<string | null> {
  const rec = await rememberIdbGet(githubLogin);
  if (!rec?.remember_until || new Date(rec.remember_until) <= new Date()) {
    if (rec) await rememberIdbDelete(githubLogin);
    return null;
  }
  try {
    const key = await deriveDeviceRememberKey();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64Decode(rec.iv) },
      key,
      b64Decode(rec.ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    await rememberIdbDelete(githubLogin);
    return null;
  }
}

export async function clearRememberPassphrase(githubLogin: string): Promise<void> {
  await rememberIdbDelete(githubLogin);
}

/** True when a non-expired remembered passphrase exists for this login. */
export async function hasRememberPassphrase(githubLogin: string): Promise<boolean> {
  const rec = await rememberIdbGet(githubLogin);
  if (!rec?.remember_until) return false;
  if (new Date(rec.remember_until) <= new Date()) {
    await rememberIdbDelete(githubLogin);
    return false;
  }
  return true;
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveKey",
    "deriveBits",
  ]);
}

/** SHA-256(SPKI) first 16 bytes as hex — stored alongside ciphertext rows. */
export async function fingerprintPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const hash = await crypto.subtle.digest("SHA-256", spki);
  return [...new Uint8Array(hash)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveAesKey(sharedBits: Bytes): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", toBytes(sharedBits), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Ensure a per-login ECDH key pair exists in IndexedDB.
 */
export async function ensureZkKeyPair(
  githubLogin: string,
): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey; pubkeyFp: string }> {
  const existing = await idbGet(githubLogin);
  if (existing?.publicKey && existing?.privateKey) {
    const pubkeyFp = existing.pubkeyFp ?? (await fingerprintPublicKey(existing.publicKey));
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
export async function eciesEncrypt(publicKey: CryptoKey, plaintext: string): Promise<string> {
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    ephemeral.privateKey,
    256,
  );
  const aesKey = await deriveAesKey(shared);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  );
  const epk = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
  return JSON.stringify({
    v: 1,
    epk: b64Encode(epk),
    iv: b64Encode(iv),
    ct: b64Encode(ct),
  });
}

/** ECIES decrypt envelope JSON to plaintext string. */
export async function eciesDecrypt(privateKey: CryptoKey, envelopeJson: string): Promise<string> {
  const env = JSON.parse(envelopeJson);
  if (env.v !== 1) throw new Error("unsupported envelope version");

  const epkRaw = b64Decode(env.epk);
  const ephemeralPub = await crypto.subtle.importKey(
    "raw",
    epkRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeralPub },
    privateKey,
    256,
  );
  const aesKey = await deriveAesKey(shared);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(env.iv) },
    aesKey,
    b64Decode(env.ct),
  );
  return new TextDecoder().decode(plain);
}

/** Encrypt issue content `{ title, body? }`. */
export async function sealContent(publicKey: CryptoKey, content: IssueContent): Promise<string> {
  return eciesEncrypt(publicKey, JSON.stringify(content));
}

/** Decrypt issue content envelope. */
export async function openContent(
  privateKey: CryptoKey,
  envelopeJson: string,
): Promise<IssueContent> {
  const plain = await eciesDecrypt(privateKey, envelopeJson);
  return JSON.parse(plain);
}

/** Encrypt issue title payload `{ title }`. */
export async function sealTitle(publicKey: CryptoKey, title: string): Promise<string> {
  return sealContent(publicKey, { title });
}

/** Decrypt issue title from envelope (legacy + content payloads). */
export async function openTitle(
  privateKey: CryptoKey,
  envelopeJson: string,
): Promise<string | null> {
  const obj = await openContent(privateKey, envelopeJson);
  return obj.title ?? null;
}

// --- accountKey hierarchy (#216) ---

/** Generate a random AES-256-GCM accountKey (extractable for wrapping). */
export async function generateAccountKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** SHA-256(rawAccountKey)[0:16] hex — stored in zk_payloads.key_fp / zk_key_backups.key_fp. */
export async function fingerprintAccountKey(accountKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", accountKey);
  return fingerprintAccountKeyRaw(raw);
}

/** Fingerprint from raw 32-byte account key material. */
export async function fingerprintAccountKeyRaw(rawAccountKey: Bytes): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", toBytes(rawAccountKey));
  return hexEncode(new Uint8Array(hash).slice(0, 16));
}

/** Re-import accountKey as non-extractable session key after wrapping. */
export async function sessionAccountKey(accountKey: CryptoKey): Promise<CryptoKey> {
  const raw = await crypto.subtle.exportKey("raw", accountKey);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Wrap accountKey with passphrase-derived wrapping key.
 */
export async function wrapAccountKey(
  passphrase: string,
  accountKey: CryptoKey,
): Promise<WrappedAccountKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await deriveWrappingKey(passphrase, salt, ARGON2_PARAMS);
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const rawAccountKey = await crypto.subtle.exportKey("raw", accountKey);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv },
    wrappingKey,
    rawAccountKey,
  );
  return {
    kdf_alg: "argon2id",
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
 */
async function decryptWrappedAccountKeyRaw(
  passphrase: string,
  backup: KeyBackupBlob,
): Promise<ArrayBuffer> {
  const blob =
    typeof backup.kdf_params === "string" ? JSON.parse(backup.kdf_params) : backup.kdf_params;
  if (blob.m !== ARGON2_PARAMS.m || blob.t !== ARGON2_PARAMS.t || blob.p !== ARGON2_PARAMS.p) {
    throw new Error("kdf_param_mismatch");
  }
  const salt = hexDecode(blob.salt);
  const wrappingKey = await deriveWrappingKey(passphrase, salt, ARGON2_PARAMS);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(backup.wrap_iv) },
    wrappingKey,
    b64Decode(backup.wrapped_key),
  );
}

export async function unwrapAccountKey(
  passphrase: string,
  backup: KeyBackupBlob,
): Promise<CryptoKey> {
  const rawAccountKey = await decryptWrappedAccountKeyRaw(passphrase, backup);
  return crypto.subtle.importKey("raw", rawAccountKey, { name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Re-wrap an existing backup with a new passphrase (rotation). */
export async function rewrapAccountKeyBackup(
  currentPassphrase: string,
  newPassphrase: string,
  backup: KeyBackupBlob,
): Promise<WrappedAccountKey> {
  const rawAccountKey = await decryptWrappedAccountKeyRaw(currentPassphrase, backup);
  const extractable = await crypto.subtle.importKey(
    "raw",
    rawAccountKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  return wrapAccountKey(newPassphrase, extractable);
}

/** v2 envelope encrypt `{ title, body? }` with accountKey. */
export async function sealWithAccountKey(
  accountKey: CryptoKey,
  content: IssueContent,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    accountKey,
    new TextEncoder().encode(JSON.stringify(content)),
  );
  return JSON.stringify({
    v: 2,
    alg: "AES-GCM-256",
    iv: b64Encode(iv),
    ct: b64Encode(ct),
  });
}

/** v2 envelope decrypt to `{ title, body? }`. */
export async function openWithAccountKey(
  accountKey: CryptoKey,
  envelopeJson: string | Record<string, unknown>,
): Promise<IssueContent> {
  const env = parseEnvelope(envelopeJson);
  if (env.v !== 2) throw new Error("unsupported envelope version");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(env.iv) },
    accountKey,
    b64Decode(env.ct),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Dual-read decrypt: v2 accountKey or v1 ECDH privateKey.
 */
export async function openContentDual(
  keys: { accountKey?: CryptoKey; privateKey?: CryptoKey },
  envelopeJson: string,
): Promise<IssueContent> {
  const env = parseEnvelope(envelopeJson);
  if (env.v === 2) {
    if (!keys.accountKey) throw new Error("accountKey required for v2 envelope");
    return openWithAccountKey(keys.accountKey, env);
  }
  if (env.v === 1) {
    if (!keys.privateKey) throw new Error("privateKey required for v1 envelope");
    return openContent(keys.privateKey, envelopeJson);
  }
  throw new Error("unsupported envelope version");
}
