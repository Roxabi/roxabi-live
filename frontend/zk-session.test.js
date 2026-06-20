import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearZkSession,
  setZkSession,
  isZkUnlocked,
  setZkPageRestoreHandler,
  setZkAutoLockHandler,
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

describe("wireIdleLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearZkSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearZkSession();
    setZkAutoLockHandler(null);
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
});
