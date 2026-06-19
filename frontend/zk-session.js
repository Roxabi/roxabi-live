// zk-session.js — in-memory accountKey session (#216 PR 4)

const IDLE_MS = 15 * 60 * 1000;

/** @type {CryptoKey|null} */
let sessionKey = null;
/** @type {string|null} */
let sessionKeyFp = null;
let idleTimer = null;
let idleWired = false;
let pageHideWired = false;
let pageShowWired = false;

/** @type {(() => void)|null} */
let onAutoLock = null;
/** @type {(() => void)|null} */
let onPageRestore = null;

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

export function setZkSession(accountKey, keyFp) {
  sessionKey = accountKey;
  sessionKeyFp = keyFp;
  resetIdleTimer();
}

export function clearZkSession() {
  sessionKey = null;
  sessionKeyFp = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!sessionKey) return;
  idleTimer = setTimeout(() => {
    clearZkSession();
    console.info("[zk]", { event: "zk.lock.idle" });
    onAutoLock?.();
  }, IDLE_MS);
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
