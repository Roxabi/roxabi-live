// zk-session.js — in-memory accountKey session (#216 PR 4)

const IDLE_MS = 15 * 60 * 1000;
const REMEMBER_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
// setTimeout coerces its delay to a signed 32-bit int; any value above this
// ceiling (~24.8 days) overflows to a negative delay and fires immediately.
// REMEMBER_IDLE_MS (30 days) exceeds it, so the idle lock used to fire on the
// next tick and loop (zk.lock.idle → silent device restore → re-arm → repeat).
// Re-arm in bounded chunks against an absolute deadline instead.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** @type {CryptoKey|null} */
let sessionKey = null;
/** @type {string|null} */
let sessionKeyFp = null;
let idleTimer = null;
let idleDeadline = 0;
let idleWired = false;
let pageHideWired = false;
let pageShowWired = false;
let rememberMode = false;

/** @type {(() => void)|null} */
let onAutoLock = null;
/** @type {(() => void)|null} */
let onPageRestore = null;
/** @type {(() => void)|null} */
let onSessionReady = null;

export function isZkUnlocked() {
  return sessionKey !== null;
}

/** @returns {CryptoKey} */
export function getSessionAccountKey() {
  if (!sessionKey) throw new Error("ZK locked");
  return sessionKey;
}

export function getSessionKeyFp() {
  return sessionKeyFp;
}

export function setZkRememberMode(active) {
  rememberMode = Boolean(active);
  if (sessionKey) resetIdleTimer();
}

export function isZkRememberMode() {
  return rememberMode;
}

function currentIdleMs() {
  return rememberMode ? REMEMBER_IDLE_MS : IDLE_MS;
}

/** Fires after accountKey is loaded into memory (unlock, device restore, enroll). */
export function setZkSessionReadyHandler(fn) {
  onSessionReady = fn;
}

export function setZkSession(accountKey, keyFp) {
  sessionKey = accountKey;
  sessionKeyFp = keyFp;
  resetIdleTimer();
  onSessionReady?.();
}

export function clearZkSession() {
  sessionKey = null;
  sessionKeyFp = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function fireIdleLock() {
  clearZkSession();
  console.info("[zk]", { event: "zk.lock.idle", remember: rememberMode });
  onAutoLock?.();
}

// Re-arm the idle timer in chunks no larger than MAX_TIMEOUT_MS so a long
// REMEMBER_IDLE_MS deadline never overflows setTimeout and fires early.
function armIdleChunk() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!sessionKey) return;
  const remaining = idleDeadline - Date.now();
  if (remaining <= 0) {
    fireIdleLock();
    return;
  }
  idleTimer = setTimeout(armIdleChunk, Math.min(remaining, MAX_TIMEOUT_MS));
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!sessionKey) return;
  idleDeadline = Date.now() + currentIdleMs();
  armIdleChunk();
}

/** Register callback when idle lock fires (e.g. show unlock gate). */
export function setZkAutoLockHandler(fn) {
  onAutoLock = fn;
}

/** Register callback when BFCache restores a page after session was cleared. */
export function setZkPageRestoreHandler(fn) {
  onPageRestore = fn;
}

export function wireIdleLock() {
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

export function wirePageHideLock() {
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
