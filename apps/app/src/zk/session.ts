// session.ts — in-memory accountKey session.
// VERBATIM port of frontend/zk-session.js (#216 PR 4). The CryptoKey lives in
// MODULE SCOPE — never React state — so a re-render can never leak or drop it.
// The chunked idle re-arm guards setTimeout's 32-bit overflow in 30-day mode.

const IDLE_MS = 15 * 60 * 1000;
const REMEMBER_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
// setTimeout coerces its delay to a signed 32-bit int; any value above this
// ceiling (~24.8 days) overflows to a negative delay and fires immediately.
// REMEMBER_IDLE_MS (30 days) exceeds it, so the idle lock used to fire on the
// next tick and loop (zk.lock.idle → silent device restore → re-arm → repeat).
// Re-arm in bounded chunks against an absolute deadline instead.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

let sessionKey: CryptoKey | null = null;
let sessionKeyFp: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleDeadline = 0;
let idleWired = false;
let pageHideWired = false;
let pageShowWired = false;
let rememberMode = false;

let onAutoLock: (() => void) | null = null;
let onPageRestore: (() => void) | null = null;
let onSessionReady: (() => void) | null = null;

export function isZkUnlocked(): boolean {
  return sessionKey !== null;
}

export function getSessionAccountKey(): CryptoKey {
  if (!sessionKey) throw new Error("ZK locked");
  return sessionKey;
}

export function getSessionKeyFp(): string | null {
  return sessionKeyFp;
}

export function setZkRememberMode(active: boolean): void {
  rememberMode = Boolean(active);
  if (sessionKey) resetIdleTimer();
}

export function isZkRememberMode(): boolean {
  return rememberMode;
}

function currentIdleMs(): number {
  return rememberMode ? REMEMBER_IDLE_MS : IDLE_MS;
}

/** Fires after accountKey is loaded into memory (unlock, device restore, enroll). */
export function setZkSessionReadyHandler(fn: (() => void) | null): void {
  onSessionReady = fn;
}

export function setZkSession(accountKey: CryptoKey, keyFp: string | null): void {
  sessionKey = accountKey;
  sessionKeyFp = keyFp;
  resetIdleTimer();
  onSessionReady?.();
}

export function clearZkSession(): void {
  sessionKey = null;
  sessionKeyFp = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function fireIdleLock(): void {
  clearZkSession();
  console.info("[zk]", { event: "zk.lock.idle", remember: rememberMode });
  onAutoLock?.();
}

// Re-arm the idle timer in chunks no larger than MAX_TIMEOUT_MS so a long
// REMEMBER_IDLE_MS deadline never overflows setTimeout and fires early.
function armIdleChunk(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (!sessionKey) return;
  const remaining = idleDeadline - Date.now();
  if (remaining <= 0) {
    fireIdleLock();
    return;
  }
  idleTimer = setTimeout(armIdleChunk, Math.min(remaining, MAX_TIMEOUT_MS));
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (!sessionKey) return;
  idleDeadline = Date.now() + currentIdleMs();
  armIdleChunk();
}

/** Register callback when idle lock fires (e.g. show unlock gate). */
export function setZkAutoLockHandler(fn: (() => void) | null): void {
  onAutoLock = fn;
}

/** Register callback when BFCache restores a page after session was cleared. */
export function setZkPageRestoreHandler(fn: (() => void) | null): void {
  onPageRestore = fn;
}

export function wireIdleLock(): void {
  if (idleWired) return;
  idleWired = true;
  const bump = () => {
    if (sessionKey) resetIdleTimer();
  };
  for (const ev of ["pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(ev, bump, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    // Restart the countdown on BOTH transitions so a backgrounded tab still
    // auto-locks 15 min after it was hidden (not 15 min after it next becomes
    // visible). Do not clear immediately — a quick tab switch must not lock.
    if (sessionKey) resetIdleTimer();
  });
}

export function wirePageHideLock(): void {
  if (pageHideWired) return;
  pageHideWired = true;
  window.addEventListener("pagehide", clearZkSession);
  window.addEventListener("beforeunload", clearZkSession);
  if (!pageShowWired) {
    pageShowWired = true;
    window.addEventListener("pageshow", (ev) => {
      if (ev.persisted && !sessionKey) {
        onPageRestore?.();
      }
    });
  }
}
