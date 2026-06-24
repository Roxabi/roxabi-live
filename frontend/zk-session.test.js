import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearZkSession,
  setZkSession,
  isZkUnlocked,
  setZkPageRestoreHandler,
  setZkAutoLockHandler,
  setZkSessionReadyHandler,
  setZkRememberMode,
  wirePageHideLock,
  wireIdleLock,
} = await import("./zk-session.js");

describe("wirePageHideLock BFCache restore", () => {
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

  it("invokes page restore handler when BFCache restores while locked", () => {
    setZkSession({}, "fp12345678");
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(isZkUnlocked()).toBe(false);

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));

    expect(restoreHandler).toHaveBeenCalledTimes(1);
  });

  it("does not invoke restore handler when session is still unlocked", () => {
    setZkSession({}, "fp12345678");

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));

    expect(restoreHandler).not.toHaveBeenCalled();
  });
});

describe("setZkSessionReadyHandler", () => {
  afterEach(() => {
    clearZkSession();
    setZkSessionReadyHandler(null);
  });

  it("invokes handler when session is established", () => {
    const onReady = vi.fn();
    setZkSessionReadyHandler(onReady);
    setZkSession({}, "fp12345678");
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not invoke handler on clearZkSession", () => {
    const onReady = vi.fn();
    setZkSessionReadyHandler(onReady);
    setZkSession({}, "fp12345678");
    onReady.mockClear();
    clearZkSession();
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe("wireIdleLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearZkSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearZkSession();
    setZkAutoLockHandler(null);
    setZkRememberMode(false);
  });

  it("fires auto-lock handler after 15 minutes idle", () => {
    const onLock = vi.fn();
    setZkAutoLockHandler(onLock);
    wireIdleLock();
    setZkSession({}, "fp12345678");

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(isZkUnlocked()).toBe(false);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("does not auto-lock immediately in 30-day remember mode (setTimeout overflow guard)", () => {
    const onLock = vi.fn();
    setZkAutoLockHandler(onLock);
    setZkRememberMode(true);
    wireIdleLock();
    setZkSession({}, "fp12345678");

    // Regression: REMEMBER_IDLE_MS (30d) used to overflow setTimeout's 32-bit
    // cap and fire on the next tick, looping idle→restore. Advancing well past
    // any short interval must NOT lock.
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 h
    expect(isZkUnlocked()).toBe(true);
    expect(onLock).not.toHaveBeenCalled();

    // It still locks once the full remember window elapses.
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000); // +30 d
    expect(isZkUnlocked()).toBe(false);
    expect(onLock).toHaveBeenCalledTimes(1);
  });
});
