import { describe, it, expect, beforeAll } from 'vitest';
import {
  eciesEncrypt,
  eciesDecrypt,
  sealTitle,
  openTitle,
  sealContent,
  openContent,
  fingerprintPublicKey,
} from './zk-crypto.js';

describe('zk-crypto ECIES', () => {
  /** @type {CryptoKey} */
  let publicKey;
  /** @type {CryptoKey} */
  let privateKey;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
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
});