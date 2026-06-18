import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.fn();
const isZkUnlockedMock = vi.fn();
const ensureZkKeyPairMock = vi.fn();

vi.mock('./auth.js', () => ({
  api: (...args) => apiMock(...args),
}));

vi.mock('./zk-session.js', () => ({
  isZkUnlocked: () => isZkUnlockedMock(),
  getSessionAccountKey: () => {
    throw new Error('ZK locked');
  },
}));

vi.mock('./zk-crypto.js', () => ({
  ensureZkKeyPair: (...args) => ensureZkKeyPairMock(...args),
  openContent: vi.fn(),
  parseEnvelopeVersion: () => 2,
  hasZkKeyPair: vi.fn(),
  sealContent: vi.fn(),
  sealWithAccountKey: vi.fn(),
  openContentDual: vi.fn(),
  deleteZkKeyPair: vi.fn(),
}));

const { applyZkDecryption, SEALED_TITLE_LABEL } = await import('./zk-sync.js');

describe('applyZkDecryption', () => {
  beforeEach(() => {
    apiMock.mockReset();
    isZkUnlockedMock.mockReset();
    ensureZkKeyPairMock.mockReset();
  });

  it('skips keypair fetch when account key mode is locked', async () => {
    isZkUnlockedMock.mockReturnValue(false);
    const nodes = [{ key: 'Roxabi/live#1', title: null }];

    await applyZkDecryption(nodes, 'alice', { accountKeyMode: true });

    expect(apiMock).not.toHaveBeenCalled();
    expect(ensureZkKeyPairMock).not.toHaveBeenCalled();
    expect(nodes[0].title).toBe(SEALED_TITLE_LABEL);
  });
});