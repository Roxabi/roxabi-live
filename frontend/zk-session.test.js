import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  clearZkSession,
  setZkSession,
  isZkUnlocked,
  setZkPageRestoreHandler,
  wirePageHideLock,
} = await import('./zk-session.js');

describe('wirePageHideLock BFCache restore', () => {
  let restoreHandler;

  beforeEach(() => {
    restoreHandler = vi.fn();
    setZkPageRestoreHandler(restoreHandler);
    wirePageHideLock();
    clearZkSession();
  });

  afterEach(() => {
    clearZkSession();
    setZkPageRestoreHandler(null);
  });

  it('invokes page restore handler when BFCache restores while locked', () => {
    setZkSession({}, 'fp12345678');
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(isZkUnlocked()).toBe(false);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

    expect(restoreHandler).toHaveBeenCalledTimes(1);
  });

  it('does not invoke restore handler when session is still unlocked', () => {
    setZkSession({}, 'fp12345678');

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

    expect(restoreHandler).not.toHaveBeenCalled();
  });
});