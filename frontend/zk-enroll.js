// zk-enroll.js — passphrase enrollment, unlock, lock UI (#216 PR 4)

import { api, escHtml } from './auth.js';
import {
  generateAccountKey,
  wrapAccountKey,
  unwrapAccountKey,
  sessionAccountKey,
  hasZkKeyPair,
  saveAccountMeta,
  parseEnvelopeVersion,
  saveDeviceSession,
  loadDeviceSession,
  clearDeviceSession,
} from './zk-crypto.js';
import {
  isZkUnlocked,
  setZkSession,
  clearZkSession,
  wireIdleLock,
  wirePageHideLock,
  setZkAutoLockHandler,
  setZkPageRestoreHandler,
} from './zk-session.js';
import { migrateV1PayloadsToAccountKey } from './zk-sync.js';
import {
  getZkReauthProof,
  clearZkReauthProof,
} from './zk-github.js';
import {
  wireZkResetUi,
  showLostPassphraseWarning,
} from './zk-reset.js';

const $ = (id) => document.getElementById(id);

/** Set during requireZkEnrollmentGate for migration retry on unlock. */
let gateGithubLogin = '';

function zkLog(event, extra = {}) {
  console.info('[zk]', { event, ...extra });
}

export { isZkUnlocked, getSessionAccountKey, getSessionKeyFp } from './zk-session.js';

export function lockZkSession() {
  if (!isZkUnlocked()) return;
  clearZkSession();
  if (gateGithubLogin) {
    clearDeviceSession(gateGithubLogin).catch(() => {});
  }
  zkLog('zk.lock.explicit');
  updateLockButton();
  showUnlockGate().catch(() => {});
}

/**
 * Restore unlocked session from this device's IndexedDB when key_fp matches
 * the server backup (same browser, reload / new tab — no passphrase re-entry).
 */
export async function tryRestoreDeviceZkSession(githubLogin) {
  if (isZkUnlocked()) return true;
  try {
    const backup = await fetchKeyBackup();
    const local = await loadDeviceSession(githubLogin);
    if (!local?.accountKey || local.key_fp !== backup.key_fp) return false;
    setZkSession(local.accountKey, local.key_fp);
    zkLog('zk.device.restore', { key_fp: local.key_fp });
    updateLockButton();
    return true;
  } catch {
    return false;
  }
}

async function fetchKeyBackup() {
  const resp = await api('/api/zk/key-backup');
  return resp.json();
}

async function putKeyBackup(body) {
  const resp = await api('/api/zk/key-backup', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

/**
 * PUT backup update (passphrase change or rotation) — attaches OAuth reauth_proof
 * from sessionStorage after /login?reauth=1 flow.
 */
export async function updateKeyBackup(body) {
  const reauth_proof = getZkReauthProof();
  if (!reauth_proof) {
    throw new Error('reauth_required');
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
    const resp = await api('/api/zk/payloads');
    const data = await resp.json();
    return data.payloads ?? [];
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

  const migrated = await migrateV1PayloadsToAccountKey(
    githubLogin,
    session,
    wrapped.key_fp,
  );

  setZkSession(session, wrapped.key_fp);
  await saveDeviceSession(githubLogin, session, wrapped.key_fp);
  zkLog('zk.enroll.success', {
    key_fp: wrapped.key_fp,
    kdf_duration_ms: Math.round(performance.now() - t0),
    migrated,
  });
  return { key_fp: wrapped.key_fp, migrated };
}

export async function unlockAccountKey(passphrase) {
  const t0 = performance.now();
  const backup = await fetchKeyBackup();
  try {
    const accountKey = await unwrapAccountKey(passphrase, backup);
    setZkSession(accountKey, backup.key_fp);
    if (gateGithubLogin) {
      await saveDeviceSession(gateGithubLogin, accountKey, backup.key_fp);
      const payloads = await fetchPayloadRows();
      if (payloadsHaveV1(payloads) && (await hasZkKeyPair(gateGithubLogin))) {
        await migrateV1PayloadsToAccountKey(
          gateGithubLogin,
          accountKey,
          backup.key_fp,
        );
      }
    }
    zkLog('zk.unlock.success', {
      key_fp: backup.key_fp,
      kdf_duration_ms: Math.round(performance.now() - t0),
    });
    return { key_fp: backup.key_fp };
  } catch (err) {
    zkLog('zk.unlock.failure');
    throw err;
  }
}

function showZkGate() {
  document.body.classList.add('gated');
  const el = $('zk-gate');
  if (el) el.removeAttribute('hidden');
}

function hideZkGate() {
  document.body.classList.remove('gated');
  const el = $('zk-gate');
  if (el) {
    el.setAttribute('hidden', '');
    el.innerHTML = '';
  }
}

function renderZkDialog(title, bodyHtml) {
  showZkGate();
  const el = $('zk-gate');
  el.innerHTML = `
    <div class="zk-dialog" role="dialog" aria-modal="true" aria-labelledby="zk-dialog-title">
      <h2 id="zk-dialog-title">${escHtml(title)}</h2>
      ${bodyHtml}
    </div>
  `;
  return el;
}

function renderDevice2Block() {
  renderZkDialog(
    'Complete setup on your original device',
    `
      <p>
        Encrypted issue titles on this account were sealed on another browser
        before passphrase backup was configured. This device cannot decrypt them
        or finish enrollment until you open Roxabi on your <strong>original device</strong>
        and complete encryption setup there.
      </p>
      <p>
        Alternatively, after setup on the original device, you can
        <a href="/login?zk=1">Link GitHub</a> here to re-seal content from GitHub.
      </p>
      <div class="zk-actions">
        <button type="button" class="consent-btn-secondary" id="zk-block-reload">Reload</button>
        <button type="button" class="consent-btn-secondary" id="zk-block-logout">Sign out</button>
      </div>
    `,
  );
  $('zk-block-reload')?.addEventListener('click', () => location.reload());
  $('zk-block-logout')?.addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
}

export function showEnrollGate(githubLogin) {
  return new Promise((resolve) => {
    renderZkDialog(
      'Set encryption passphrase',
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
          <p class="zk-error" id="zk-enroll-error" hidden></p>
          <div class="zk-actions">
            <button type="button" class="consent-btn-secondary" id="zk-enroll-logout">Sign out</button>
            <button type="submit" class="consent-btn-primary" id="zk-enroll-submit">Create backup</button>
          </div>
        </form>
      `,
    );

    const form = $('zk-enroll-form');
    const passInput = $('zk-enroll-pass');
    const confirmInput = $('zk-enroll-confirm');
    const errorEl = $('zk-enroll-error');
    const submitBtn = $('zk-enroll-submit');

    passInput?.focus();

    $('zk-enroll-logout')?.addEventListener('click', async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      location.reload();
    });

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const pass = passInput.value;
      const confirm = confirmInput.value;
      if (pass.length < 8) {
        errorEl.textContent = 'Passphrase must be at least 8 characters.';
        errorEl.hidden = false;
        return;
      }
      if (pass !== confirm) {
        errorEl.textContent = 'Passphrases do not match.';
        errorEl.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating backup…';
      try {
        await enrollAccountKey(pass, githubLogin);
        hideZkGate();
        resolve();
      } catch (err) {
        if (String(err?.message ?? '').includes('409')) {
          errorEl.textContent = 'Already enrolled — unlock with your passphrase instead.';
        } else {
          errorEl.textContent = err?.message ?? 'Enrollment failed. Try again.';
        }
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create backup';
      }
    });
  });
}

export function showUnlockGate(githubLogin = gateGithubLogin) {
  return new Promise((resolve) => {
    const resetCtx = { $, escHtml, renderZkDialog };
    const reopenUnlock = () => {
      showUnlockGate(githubLogin).then(resolve);
    };
    if (wireZkResetUi(resetCtx, githubLogin, reopenUnlock)) {
      return;
    }

    renderZkDialog(
      'Unlock encryption',
      `
        <p>Enter your encryption passphrase to decrypt issue titles and bodies on this device.</p>
        <form class="zk-form" id="zk-unlock-form">
          <label class="zk-field">
            <span>Passphrase</span>
            <input type="password" id="zk-unlock-pass" autocomplete="current-password" required />
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

    $('zk-lost-pass')?.addEventListener('click', () => {
      showLostPassphraseWarning(resetCtx, reopenUnlock);
    });

    const form = $('zk-unlock-form');
    const passInput = $('zk-unlock-pass');
    const errorEl = $('zk-unlock-error');
    const submitBtn = $('zk-unlock-submit');

    passInput?.focus();

    $('zk-unlock-logout')?.addEventListener('click', async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      location.reload();
    });

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Unlocking…';
      try {
        await unlockAccountKey(passInput.value);
        hideZkGate();
        resolve();
      } catch {
        errorEl.textContent = 'Incorrect passphrase. Try again.';
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock';
        passInput.select();
      }
    });
  });
}

function updateLockButton() {
  const btn = $('zk-lock-btn');
  if (!btn) return;
  if (isZkUnlocked()) {
    btn.removeAttribute('hidden');
    btn.textContent = 'Lock';
    btn.title = 'Lock encryption (clear key from memory)';
  } else {
    btn.setAttribute('hidden', '');
  }
}

export function wireZkLockButton() {
  const btn = $('zk-lock-btn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => lockZkSession());
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
    showUnlockGate().catch(() => {});
  });
  setZkPageRestoreHandler(() => {
    if (me.user?.zk_enrolled === true && !isZkUnlocked()) {
      tryRestoreDeviceZkSession(githubLogin).then((restored) => {
        if (!restored) {
          updateLockButton();
          showUnlockGate().catch(() => {});
        }
      });
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
    if (!(await tryRestoreDeviceZkSession(githubLogin))) {
      await showUnlockGate();
    }
    return true;
  }

  updateLockButton();
  return true;
}