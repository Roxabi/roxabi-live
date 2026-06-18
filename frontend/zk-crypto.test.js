import { describe, it, expect, beforeAll } from 'vitest';
import { argon2id } from './vendor/hash-wasm/esm/index.js';
import { deriveWrappingKey, ARGON2_PARAMS } from './zk-kdf.js';
import kdfVectors from './test/fixtures/zk-kdf-vectors.json';
import {
  eciesEncrypt,
  eciesDecrypt,
  sealTitle,
  openTitle,
  sealContent,
  openContent,
  fingerprintPublicKey,
  generateAccountKey,
  wrapAccountKey,
  unwrapAccountKey,
  sessionAccountKey,
  sealWithAccountKey,
  openWithAccountKey,
  openContentDual,
  fingerprintAccountKey,
  ARGON2_PARAMS as CRYPTO_ARGON2_PARAMS,
} from './zk-crypto.js';

function hexDecode(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexEncode(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('zk-kdf Argon2id', () => {
  it('exports fixed ARGON2_PARAMS', () => {
    expect(ARGON2_PARAMS).toEqual({ m: 65536, t: 3, p: 1 });
    expect(CRYPTO_ARGON2_PARAMS).toEqual(ARGON2_PARAMS);
  });

  it('matches golden KDF vector', async () => {
    const salt = hexDecode(kdfVectors.salt_hex);
    const raw = await argon2id({
      password: kdfVectors.passphrase,
      salt,
      parallelism: kdfVectors.params.p,
      iterations: kdfVectors.params.t,
      memorySize: kdfVectors.params.m,
      hashLength: 32,
      outputType: 'binary',
    });
    expect(hexEncode(raw)).toBe(kdfVectors.output_hex);
  });

  it('deriveWrappingKey imports 32-byte AES-GCM key', async () => {
    const salt = hexDecode(kdfVectors.salt_hex);
    const key = await deriveWrappingKey(kdfVectors.passphrase, salt, kdfVectors.params);
    expect(key.type).toBe('secret');
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.extractable).toBe(false);
  });
});

describe('zk-crypto accountKey v2', () => {
  /** @type {CryptoKey} */
  let accountKey;

  beforeAll(async () => {
    accountKey = await generateAccountKey();
  });

  it('sealWithAccountKey/openWithAccountKey roundtrips content', async () => {
    const envelope = await sealWithAccountKey(accountKey, {
      title: 'Secret issue',
      body: 'Private body',
    });
    const parsed = JSON.parse(envelope);
    expect(parsed).toMatchObject({ v: 2, alg: 'AES-GCM-256' });

    const session = await sessionAccountKey(accountKey);
    const content = await openWithAccountKey(session, envelope);
    expect(content.title).toBe('Secret issue');
    expect(content.body).toBe('Private body');
  });

  it('wrapAccountKey/unwrapAccountKey roundtrips accountKey', async () => {
    const passphrase = 'strong-test-passphrase-216';
    const backup = await wrapAccountKey(passphrase, accountKey);
    expect(backup.kdf_alg).toBe('argon2id');
    expect(backup.key_fp).toMatch(/^[0-9a-f]{32}$/);

    const unwrapped = await unwrapAccountKey(passphrase, backup);
    expect(unwrapped.extractable).toBe(false);

    const envelope = await sealWithAccountKey(accountKey, { title: 'Wrapped key test' });
    const content = await openWithAccountKey(unwrapped, envelope);
    expect(content.title).toBe('Wrapped key test');
  });

  it('fingerprintAccountKey returns 32 hex chars', async () => {
    const fp = await fingerprintAccountKey(accountKey);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(fp).toBe((await wrapAccountKey('x', accountKey)).key_fp);
  });
});

describe('zk-crypto ECIES v1 dual-read', () => {
  /** @type {CryptoKey} */
  let publicKey;
  /** @type {CryptoKey} */
  let privateKey;
  /** @type {CryptoKey} */
  let accountKey;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
    accountKey = await generateAccountKey();
  });

  it('roundtrips arbitrary plaintext', async () => {
    const envelope = await eciesEncrypt(publicKey, '{"title":"Secret issue"}');
    const plain = await eciesDecrypt(privateKey, envelope);
    expect(plain).toBe('{"title":"Secret issue"}');
  });

  it('sealTitle/openTitle extracts title', async () => {
    const envelope = await sealTitle(publicKey, 'Fix the bug');
    expect(await openTitle(privateKey, envelope)).toBe('Fix the bug');
  });

  it('sealContent/openContent roundtrips title and body', async () => {
    const envelope = await sealContent(publicKey, {
      title: 'Secret',
      body: 'Private body text',
    });
    const content = await openContent(privateKey, envelope);
    expect(content.title).toBe('Secret');
    expect(content.body).toBe('Private body text');
  });

  it('fingerprintPublicKey returns 32 hex chars', async () => {
    const fp = await fingerprintPublicKey(publicKey);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it('openContentDual reads v1 via privateKey', async () => {
    const envelope = await sealContent(publicKey, { title: 'v1 dual-read' });
    const content = await openContentDual({ privateKey }, envelope);
    expect(content.title).toBe('v1 dual-read');
  });

  it('openContentDual reads v2 via accountKey', async () => {
    const envelope = await sealWithAccountKey(accountKey, { title: 'v2 dual-read' });
    const session = await sessionAccountKey(accountKey);
    const content = await openContentDual({ accountKey: session }, envelope);
    expect(content.title).toBe('v2 dual-read');
  });

  it('migrates v1 ECIES envelope to v2 accountKey envelope', async () => {
    const v1Envelope = await sealContent(publicKey, {
      title: 'Legacy title',
      body: 'Legacy body',
    });
    expect(JSON.parse(v1Envelope).v).toBe(1);

    const plaintext = await openContent(privateKey, v1Envelope);
    const v2Envelope = await sealWithAccountKey(accountKey, plaintext);
    expect(JSON.parse(v2Envelope).v).toBe(2);

    const session = await sessionAccountKey(accountKey);
    const migrated = await openContentDual({ accountKey: session }, v2Envelope);
    expect(migrated.title).toBe('Legacy title');
    expect(migrated.body).toBe('Legacy body');
  });
});