// zk-enroll.js — passphrase enrollment, unlock, lock UI (#216 PR 4)

import { api, escHtml, signOut } from "./auth.js";
import { applyTranslations, detectLocale } from "./i18n.js";
import {
  REMEMBER_PASSPHRASE_PREF_KEY,
  clearDeviceSession,
  clearRememberPassphrase,
  generateAccountKey,
  hasRememberPassphrase,
  hasZkKeyPair,
  loadDeviceSession,
  loadRememberPassphrase,
  parseEnvelopeVersion,
  saveAccountMeta,
  saveDeviceSession,
  saveRememberPassphrase,
  sessionAccountKey,
  unwrapAccountKey,
  wrapAccountKey,
} from "./zk-crypto.js";
import { zkLoginUrl } from "./zk-github.js";
import { clearZkReauthProof, getZkReauthProof } from "./zk-github.js";
import { showLostPassphraseWarning, wireZkResetUi } from "./zk-reset.js";
import {
  clearZkSession,
  isZkUnlocked,
  setZkAutoLockHandler,
  setZkPageRestoreHandler,
  setZkRememberMode,
  setZkSession,
  wireIdleLock,
  wirePageHideLock,
} from "./zk-session.js";
import { fetchZkPayloadRows, migrateV1PayloadsToAccountKey } from "./zk-sync.js";

const $ = (id) => document.getElementById(id);

/** Set during requireZkEnrollmentGate for migration retry on unlock. */
let gateGithubLogin = "";

/** @type {Promise<object>|null} */
let keyBackupInflight = null;
/** @type {object|null} */
let keyBackupCache = null;
/** @type {Promise<boolean>|null} */
let zkUnlockInFlight = null;
/** @type {Promise<void>|null} */
let unlockGatePromise = null;
/** @type {Promise<boolean>|null} */
let zkBootstrapPromise = null;

function invalidateKeyBackupCache() {
  keyBackupCache = null;
  keyBackupInflight = null;
}

function zkLog(event, extra = {}) {
  console.info("[zk]", { event, ...extra });
}

export { isZkUnlocked, getSessionAccountKey, getSessionKeyFp } from "./zk-session.js";

export function lockZkSession() {
  if (!isZkUnlocked()) return;
  clearZkSession();
  setZkRememberMode(false);
  if (gateGithubLogin) {
    clearDeviceSession(gateGithubLogin).catch(() => {});
    clearRememberPassphrase(gateGithubLogin).catch(() => {});
  }
  zkLog("zk.lock.explicit");
  updateLockButton();
  ensureZkUnlocked(gateGithubLogin).catch(() => {});
}

function zkRememberChecked() {
  const box = document.getElementById("zk-remember");
  return box instanceof HTMLInputElement && box.checked;
}

function wireZkRememberCheckbox() {
  const box = document.getElementById("zk-remember");
  if (!(box instanceof HTMLInputElement) || box.dataset.wired) return;
  box.dataset.wired = "1";
  if (localStorage.getItem(REMEMBER_PASSPHRASE_PREF_KEY) === "1") box.checked = true;
  box.addEventListener("change", () => {
    localStorage.setItem(REMEMBER_PASSPHRASE_PREF_KEY, box.checked ? "1" : "0");
  });
}

async function applyZkRememberChoice(githubLogin, passphrase, remember) {
  if (remember) {
    await saveRememberPassphrase(githubLogin, passphrase);
    setZkRememberMode(true);
    localStorage.setItem(REMEMBER_PASSPHRASE_PREF_KEY, "1");
  } else {
    await clearRememberPassphrase(githubLogin);
    setZkRememberMode(false);
    localStorage.setItem(REMEMBER_PASSPHRASE_PREF_KEY, "0");
  }
}

async function syncZkRememberMode(githubLogin) {
  const remembered =
    localStorage.getItem(REMEMBER_PASSPHRASE_PREF_KEY) === "1" ||
    (await hasRememberPassphrase(githubLogin));
  if (remembered) setZkRememberMode(true);
}

async function fetchKeyBackup() {
  if (keyBackupCache) return keyBackupCache;
  if (keyBackupInflight) return keyBackupInflight;
  keyBackupInflight = api("/api/zk/key-backup")
    .then((r) => r.json())
    .then((data) => {
      keyBackupCache = data;
      keyBackupInflight = null;
      return data;
    })
    .catch((err) => {
      keyBackupInflight = null;
      throw err;
    });
  return keyBackupInflight;
}

async function putKeyBackup(body) {
  const resp = await api("/api/zk/key-backup", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await resp.json();
  invalidateKeyBackupCache();
  return result;
}

/** v1→v2 migration must never block unlock — a network error used to surface as "wrong passphrase". */
async function runBestEffortV1Migration(githubLogin, accountKey, key_fp) {
  if (!githubLogin) return;
  try {
    const payloads = await fetchPayloadRows();
    if (payloadsHaveV1(payloads) && (await hasZkKeyPair(githubLogin))) {
      await migrateV1PayloadsToAccountKey(githubLogin, accountKey, key_fp);
    }
  } catch (err) {
    zkLog("zk.migrate.v1_to_v2.deferred", { error: String(err?.message ?? err) });
  }
}

/**
 * Restore from device session or remembered passphrase — at most one GET key-backup.
 */
async function tryAutoUnlockZkInner(githubLogin) {
  if (isZkUnlocked()) return true;

  let backup;
  try {
    backup = await fetchKeyBackup();
  } catch {
    return false;
  }

  const local = await loadDeviceSession(githubLogin);
  if (local?.accountKey && local.key_fp === backup.key_fp) {
    setZkSession(local.accountKey, local.key_fp);
    await syncZkRememberMode(githubLogin);
    zkLog("zk.device.restore", { key_fp: local.key_fp });
    updateLockButton();
    return true;
  }
  if (local?.key_fp && local.key_fp !== backup.key_fp) {
    await clearDeviceSession(githubLogin);
    zkLog("zk.device.stale", { local_fp: local.key_fp, server_fp: backup.key_fp });
  }

  const pass = await loadRememberPassphrase(githubLogin);
  if (!pass) return false;

  const t0 = performance.now();
  try {
    const accountKey = await unwrapAccountKey(pass, backup);
    const session = await sessionAccountKey(accountKey);
    setZkSession(session, backup.key_fp);
    if (githubLogin) {
      await saveDeviceSession(githubLogin, accountKey, backup.key_fp);
      await runBestEffortV1Migration(githubLogin, accountKey, backup.key_fp);
    }
    setZkRememberMode(true);
    zkLog("zk.unlock.success", {
      key_fp: backup.key_fp,
      kdf_duration_ms: Math.round(performance.now() - t0),
      remember: true,
    });
    updateLockButton();
    return true;
  } catch {
    clearZkSession();
    await clearRememberPassphrase(githubLogin);
    setZkRememberMode(false);
    zkLog("zk.unlock.failure");
    return false;
  }
}

async function tryAutoUnlockZk(githubLogin) {
  if (isZkUnlocked()) return true;
  if (zkUnlockInFlight) return zkUnlockInFlight;
  zkUnlockInFlight = tryAutoUnlockZkInner(githubLogin).finally(() => {
    zkUnlockInFlight = null;
  });
  return zkUnlockInFlight;
}

/** Single-flight bootstrap: auto-unlock then at most one unlock gate (init + BFCache + idle lock). */
async function ensureZkUnlocked(githubLogin) {
  if (isZkUnlocked()) return true;
  if (zkBootstrapPromise) return zkBootstrapPromise;
  zkBootstrapPromise = (async () => {
    try {
      if (await tryAutoUnlockZk(githubLogin)) {
        await syncZkRememberMode(githubLogin);
        updateLockButton();
        return true;
      }
      await showUnlockGate(githubLogin);
      return isZkUnlocked();
    } finally {
      zkBootstrapPromise = null;
    }
  })();
  return zkBootstrapPromise;
}

/** @deprecated Use tryAutoUnlockZk — kept for external importers. */
export async function tryRestoreDeviceZkSession(githubLogin) {
  return tryAutoUnlockZk(githubLogin);
}

/**
 * PUT backup update (passphrase change or rotation) — attaches OAuth reauth_proof
 * from sessionStorage after /login?reauth=1 flow.
 */
export async function updateKeyBackup(body) {
  const reauth_proof = getZkReauthProof();
  if (!reauth_proof) {
    throw new Error("reauth_required");
  }
  const result = await putKeyBackup({ ...body, reauth_proof });
  clearZkReauthProof();
  return result;
}

function payloadsHaveV1(payloads) {
  for (const row of payloads ?? []) {
    if (parseEnvelopeVersion(row.encrypted_payload) === 1) return true;
  }
  return false;
}

async function fetchPayloadRows() {
  try {
    return await fetchZkPayloadRows();
  } catch {
    return [];
  }
}

/**
 * Enroll: generate accountKey and upload wrapped backup.
 * Caller should run ensureAccountKeySealing after gate resolves.
 */
export async function enrollAccountKey(passphrase, githubLogin) {
  const t0 = performance.now();
  const accountKey = await generateAccountKey();
  const wrapped = await wrapAccountKey(passphrase, accountKey);
  await putKeyBackup(wrapped);
  const session = await sessionAccountKey(accountKey);
  await saveAccountMeta(githubLogin, {
    key_fp: wrapped.key_fp,
    enrolled_at: new Date().toISOString(),
  });

  const migrated = await migrateV1PayloadsToAccountKey(githubLogin, session, wrapped.key_fp);

  await saveDeviceSession(githubLogin, accountKey, wrapped.key_fp);
  setZkSession(session, wrapped.key_fp);
  zkLog("zk.enroll.success", {
    key_fp: wrapped.key_fp,
    kdf_duration_ms: Math.round(performance.now() - t0),
    migrated,
  });
  return { key_fp: wrapped.key_fp, migrated };
}

export async function unlockAccountKey(passphrase) {
  const t0 = performance.now();
  const backup = await fetchKeyBackup();
  let accountKey;
  try {
    accountKey = await unwrapAccountKey(passphrase, backup);
  } catch (err) {
    clearZkSession();
    zkLog("zk.unlock.failure");
    throw err;
  }
  const session = await sessionAccountKey(accountKey);
  setZkSession(session, backup.key_fp);
  if (gateGithubLogin) {
    try {
      await saveDeviceSession(gateGithubLogin, accountKey, backup.key_fp);
    } catch (err) {
      zkLog("zk.device.save.deferred", { error: String(err?.message ?? err) });
    }
    await runBestEffortV1Migration(gateGithubLogin, accountKey, backup.key_fp);
  }
  zkLog("zk.unlock.success", {
    key_fp: backup.key_fp,
    kdf_duration_ms: Math.round(performance.now() - t0),
  });
  return { key_fp: backup.key_fp };
}

function showZkGate() {
  document.body.classList.add("gated");
  const el = $("zk-gate");
  if (el) el.removeAttribute("hidden");
}

function hideZkGate() {
  document.body.classList.remove("gated");
  const el = $("zk-gate");
  if (el) {
    el.setAttribute("hidden", "");
    el.innerHTML = "";
  }
}

function renderZkDialog(title, bodyHtml) {
  showZkGate();
  const el = $("zk-gate");
  el.innerHTML = `
    <div class="zk-dialog" role="dialog" aria-modal="true" aria-labelledby="zk-dialog-title">
      <h2 id="zk-dialog-title">${escHtml(title)}</h2>
      ${bodyHtml}
    </div>
  `;
  applyTranslations(detectLocale());
  return el;
}

function renderDevice2Block() {
  renderZkDialog(
    "Complete setup on your original device",
    `
      <p>
        Encrypted issue titles on this account were sealed on another browser
        before passphrase backup was configured. This device cannot decrypt them
        or finish enrollment until you open Roxabi on your <strong>original device</strong>
        and complete encryption setup there.
      </p>
      <p>
        Alternatively, after setup on the original device, you can
        <a href="${escHtml(zkLoginUrl())}">Link GitHub</a> here to re-seal content from GitHub.
      </p>
      <div class="zk-actions">
        <button type="button" class="consent-btn-secondary" id="zk-block-reload">Reload</button>
        <button type="button" class="consent-btn-secondary" id="zk-block-logout">Sign out</button>
      </div>
    `,
  );
  $("zk-block-reload")?.addEventListener("click", () => location.reload());
  $("zk-block-logout")?.addEventListener("click", () => signOut({ after: "reload" }));
}

export function showEnrollGate(githubLogin) {
  return new Promise((resolve) => {
    renderZkDialog(
      "Set encryption passphrase",
      `
        <p>
          Choose a passphrase to protect your encryption key. It never leaves this browser;
          only a wrapped backup is stored on the server. This device remembers your key
          after setup — you will need the passphrase on other devices or after Lock.
        </p>
        <form class="zk-form" id="zk-enroll-form">
          <label class="zk-field">
            <span>Passphrase</span>
            <input type="password" id="zk-enroll-pass" autocomplete="new-password" required minlength="8" />
          </label>
          <label class="zk-field">
            <span>Confirm passphrase</span>
            <input type="password" id="zk-enroll-confirm" autocomplete="new-password" required minlength="8" />
          </label>
          <label class="zk-remember">
            <input type="checkbox" id="zk-remember" name="zk-remember" value="1" />
            <span data-i18n="zk.remember">Retenir la passphrase sur cet appareil pendant 30 jours</span>
          </label>
          <p class="zk-error" id="zk-enroll-error" hidden></p>
          <div class="zk-actions">
            <button type="button" class="consent-btn-secondary" id="zk-enroll-logout">Sign out</button>
            <button type="submit" class="consent-btn-primary" id="zk-enroll-submit">Create backup</button>
          </div>
        </form>
      `,
    );

    const form = $("zk-enroll-form");
    const passInput = $("zk-enroll-pass");
    const confirmInput = $("zk-enroll-confirm");
    const errorEl = $("zk-enroll-error");
    const submitBtn = $("zk-enroll-submit");

    passInput?.focus();
    wireZkRememberCheckbox();

    $("zk-enroll-logout")?.addEventListener("click", () => signOut({ after: "reload" }));

    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const pass = passInput.value;
      const confirm = confirmInput.value;
      if (pass.length < 8) {
        errorEl.textContent = "Passphrase must be at least 8 characters.";
        errorEl.hidden = false;
        return;
      }
      if (pass !== confirm) {
        errorEl.textContent = "Passphrases do not match.";
        errorEl.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Creating backup…";
      try {
        await enrollAccountKey(pass, githubLogin);
        await applyZkRememberChoice(githubLogin, pass, zkRememberChecked());
        hideZkGate();
        resolve();
      } catch (err) {
        if (String(err?.message ?? "").includes("409")) {
          errorEl.textContent = "Already enrolled — unlock with your passphrase instead.";
        } else {
          errorEl.textContent = err?.message ?? "Enrollment failed. Try again.";
        }
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "Create backup";
      }
    });
  });
}

export function showUnlockGate(githubLogin = gateGithubLogin) {
  if (unlockGatePromise) return unlockGatePromise;

  unlockGatePromise = new Promise((resolve) => {
    const finish = () => {
      unlockGatePromise = null;
      resolve();
    };
    const resetCtx = { $, escHtml, renderZkDialog };
    const reopenUnlock = () => {
      showUnlockGate(githubLogin).then(finish);
    };
    if (wireZkResetUi(resetCtx, githubLogin, reopenUnlock)) {
      unlockGatePromise = null;
      resolve();
      return;
    }

    renderZkDialog(
      "Unlock encryption",
      `
        <p>Enter your encryption passphrase to decrypt issue titles and bodies on this device.</p>
        <form class="zk-form" id="zk-unlock-form">
          <label class="zk-field">
            <span>Passphrase</span>
            <input type="password" id="zk-unlock-pass" autocomplete="current-password" required />
          </label>
          <label class="zk-remember">
            <input type="checkbox" id="zk-remember" name="zk-remember" value="1" />
            <span data-i18n="zk.remember">Retenir la passphrase sur cet appareil pendant 30 jours</span>
          </label>
          <p class="zk-error" id="zk-unlock-error" hidden></p>
          <div class="zk-actions">
            <button type="button" class="consent-btn-link" id="zk-lost-pass">Lost passphrase?</button>
            <button type="button" class="consent-btn-secondary" id="zk-unlock-logout">Sign out</button>
            <button type="submit" class="consent-btn-primary" id="zk-unlock-submit">Unlock</button>
          </div>
        </form>
      `,
    );

    $("zk-lost-pass")?.addEventListener("click", () => {
      showLostPassphraseWarning(resetCtx, reopenUnlock);
    });

    const form = $("zk-unlock-form");
    const passInput = $("zk-unlock-pass");
    const errorEl = $("zk-unlock-error");
    const submitBtn = $("zk-unlock-submit");

    passInput?.focus();
    wireZkRememberCheckbox();

    $("zk-unlock-logout")?.addEventListener("click", () => signOut({ after: "reload" }));

    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitBtn.disabled) return;
      errorEl.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Unlocking…";
      try {
        const pass = passInput.value;
        await unlockAccountKey(pass);
        try {
          await applyZkRememberChoice(githubLogin, pass, zkRememberChecked());
        } catch (err) {
          zkLog("zk.remember.save.deferred", { error: String(err?.message ?? err) });
        }
        hideZkGate();
        finish();
      } catch {
        if (isZkUnlocked()) {
          hideZkGate();
          finish();
          return;
        }
        errorEl.textContent = "Incorrect passphrase. Try again.";
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "Unlock";
        passInput.select();
      }
    });
  });
  return unlockGatePromise;
}

function updateLockButton() {
  const btn = $("zk-lock-btn");
  if (!btn) return;
  if (isZkUnlocked()) {
    btn.removeAttribute("hidden");
    btn.textContent = "Lock";
    btn.title = "Lock encryption (clear key from memory)";
  } else {
    btn.setAttribute("hidden", "");
  }
}

function closeUserMenu() {
  $("user-menu-panel")?.setAttribute("hidden", "");
  $("user-menu-btn")?.setAttribute("aria-expanded", "false");
}

export function wireZkLockButton() {
  const btn = $("zk-lock-btn");
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", () => {
    closeUserMenu();
    lockZkSession();
  });
  updateLockButton();
}

/**
 * Blocks dashboard until enrolled + unlocked when ZK_ACCOUNT_KEY flag is on.
 * @returns {Promise<boolean>} false when permanently blocked (Device 2 pre-enroll)
 */
export async function requireZkEnrollmentGate(me, githubLogin) {
  gateGithubLogin = githubLogin;
  wireIdleLock();
  wirePageHideLock();
  wireZkLockButton();
  setZkAutoLockHandler(() => {
    updateLockButton();
    ensureZkUnlocked(gateGithubLogin).catch(() => {});
  });
  setZkPageRestoreHandler(() => {
    if (me.user?.zk_enrolled === true && !isZkUnlocked()) {
      updateLockButton();
      ensureZkUnlocked(githubLogin).catch(() => {});
    }
  });

  const enrolled = me.user?.zk_enrolled === true;

  if (!enrolled) {
    const payloads = await fetchPayloadRows();
    const hasV1 = payloadsHaveV1(payloads);
    const hasLocalKey = await hasZkKeyPair(githubLogin);
    if (hasV1 && !hasLocalKey) {
      renderDevice2Block();
      return false;
    }
    await showEnrollGate(githubLogin);
    return true;
  }

  if (!isZkUnlocked()) {
    await ensureZkUnlocked(githubLogin);
    if (!isZkUnlocked()) return false;
    return true;
  }

  updateLockButton();
  return true;
}
