import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiMock = vi.fn();
const deleteZkKeyPairMock = vi.fn();
const deleteAccountMetaMock = vi.fn();
const clearZkSessionMock = vi.fn();
const getZkReauthProofMock = vi.fn();
const clearZkReauthProofMock = vi.fn();

vi.mock('./auth.js', () => ({ api: (...args) => apiMock(...args) }));
vi.mock('./zk-crypto.js', () => ({
  deleteZkKeyPair: (...args) => deleteZkKeyPairMock(...args),
  deleteAccountMeta: (...args) => deleteAccountMetaMock(...args),
}));
vi.mock('./zk-session.js', () => ({
  clearZkSession: () => clearZkSessionMock(),
}));
vi.mock('./zk-github.js', () => ({
  getZkReauthProof: () => getZkReauthProofMock(),
  clearZkReauthProof: () => clearZkReauthProofMock(),
  zkReauthLoginUrl: (r) => `/login?reauth=1&redirect=${encodeURIComponent(r)}`,
}));

const {
  isZkResetPending,
  setZkResetPending,
  clearZkResetPending,
  clearLocalZkState,
  resetZkAccountAndReenroll,
} = await import('./zk-reset.js');

describe('zk-reset', () => {
  beforeEach(() => {
    sessionStorage.clear();
    apiMock.mockReset();
    deleteZkKeyPairMock.mockReset();
    deleteAccountMetaMock.mockReset();
    clearZkSessionMock.mockReset();
    getZkReauthProofMock.mockReset();
    clearZkReauthProofMock.mockReset();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('tracks reset pending flag in sessionStorage', () => {
    expect(isZkResetPending()).toBe(false);
    setZkResetPending();
    expect(isZkResetPending()).toBe(true);
    clearZkResetPending();
    expect(isZkResetPending()).toBe(false);
  });

  it('clearLocalZkState wipes session and IndexedDB helpers', async () => {
    await clearLocalZkState('alice');
    expect(clearZkSessionMock).toHaveBeenCalled();
    expect(deleteZkKeyPairMock).toHaveBeenCalledWith('alice');
    expect(deleteAccountMetaMock).toHaveBeenCalledWith('alice');
    expect(clearZkReauthProofMock).toHaveBeenCalled();
  });

  it('resetZkAccountAndReenroll posts reset then reloads', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    getZkReauthProofMock.mockReturnValue('a'.repeat(32));
    apiMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await resetZkAccountAndReenroll('alice');

    expect(apiMock).toHaveBeenCalledWith('/api/zk/reset', expect.objectContaining({ method: 'POST' }));
    expect(deleteAccountMetaMock).toHaveBeenCalledWith('alice');
    expect(reload).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});