// zk-crypto.js — ECIES P-256 + IndexedDB key storage (#142 S2)
// Ephemeral ECDH-P256 → HKDF-SHA256 → AES-GCM-256

const DB_NAME = 'roxabi-zk-v1';
const STORE_NAME = 'keypairs';
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