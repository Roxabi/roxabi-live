// zk-reset.js — lost-passphrase recovery: wipe server + local ZK state (#216)

import { api } from './auth.js';
import { deleteAccountMeta, deleteZkKeyPair, clearDeviceSession } from './zk-crypto.js';
import { clearZkSession } from './zk-session.js';
import {
  getZkReauthProof,
  clearZkReauthProof,
  zkReauthLoginUrl,
} from './zk-github.js';
const RESET_PENDING_KEY = 'roxabi:zk-reset-pending';

export function isZkResetPending() {
  return sessionStorage.getItem(RESET_PENDING_KEY) === '1';
}

export function setZkResetPending() {
  sessionStorage.setItem(RESET_PENDING_KEY, '1');
}

export function clearZkResetPending() {
  sessionStorage.removeItem(RESET_PENDING_KEY);
}

/** Drop stale reset intent when OAuth step-up did not yield a proof. */
export function reconcileZkResetPendingAfterReauth() {
  if (isZkResetPending() && !getZkReauthProof()) {
    clearZkResetPending();
  }
}

/** Wipe browser key material after server reset. */
export async function clearLocalZkState(githubLogin) {
  clearZkSession();
  clearZkReauthProof();
  clearZkResetPending();
  let cleanupOk = true;
  try {
    await deleteZkKeyPair(githubLogin);
  } catch (e) {
    cleanupOk = false;
    console.warn('[zk] deleteZkKeyPair failed — clear site data manually', e);
  }
  try {
    await deleteAccountMeta(githubLogin);
  } catch (e) {
    cleanupOk = false;
    console.warn('[zk] deleteAccountMeta failed — clear site data manually', e);
  }
  try {
    await clearDeviceSession(githubLogin);
  } catch (e) {
    cleanupOk = false;
    console.warn('[zk] clearDeviceSession failed — clear site data manually', e);
  }
  return cleanupOk;
}

async function postZkReset() {
  const reauth_proof = getZkReauthProof();
  if (!reauth_proof) throw new Error('reauth_required');
  const resp = await api('/api/zk/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reauth_proof }),
  });
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (!resp.ok) {
    const err = new Error(data?.error ?? 'reset_failed');
    err.code = data?.error;
    throw err;
  }
  clearZkReauthProof();
  return data;
}

/** If server already wiped enrollment, treat reset as complete locally. */
export async function recoverFromPartialZkReset(githubLogin) {
  try {
    const meResp = await api('/api/me');
    const me = await meResp.json();
    if (me?.user?.zk_enrolled === false) {
      await clearLocalZkState(githubLogin);
      window.location.reload();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Full reset: server purge + local wipe, then enroll gate for new passphrase.
 * @param {string} githubLogin
 */
export async function resetZkAccountAndReenroll(githubLogin) {
  try {
    await postZkReset();
  } catch (err) {
    // `reauth_required` is a pre-network guard — nothing was wiped server-side,
    // so never run partial-reset recovery (it would wipe local keys / lock out
    // the user on a merely-expired proof). Only genuine partial-reset signals
    // (network error / 5xx / reset_failed) may trigger recovery.
    if (err?.code !== 'reauth_required' && err?.message !== 'reauth_required') {
      if (await recoverFromPartialZkReset(githubLogin)) return;
    }
    throw err;
  }
  await clearLocalZkState(githubLogin);
  window.location.reload();
}

function renderResetWarning($, escHtml, renderZkDialog, onCancelled) {
  renderZkDialog(
    'Reset encryption?',
    `
      <p class="consent-warning">
        <strong>This cannot be undone.</strong>
        All encrypted issue titles stored for your account on the server will be
        deleted. Your previously encrypted titles can no longer be decrypted —
        they are permanently lost. You will choose a new passphrase and re-seal
        content from GitHub.
      </p>
      <p>GitHub sign-in is required to confirm this action.</p>
      <div class="zk-actions">
        <button type="button" class="consent-btn-secondary" id="zk-reset-cancel">Cancel</button>
        <button type="button" class="consent-btn-primary" id="zk-reset-verify">Verify with GitHub</button>
      </div>
    `,
  );
  $('zk-reset-cancel')?.addEventListener('click', () => {
    clearZkResetPending();
    onCancelled?.();
  });
  $('zk-reset-verify')?.addEventListener('click', () => {
    setZkResetPending();
    const redirect = `${window.location.pathname}${window.location.search}`;
    window.location.href = zkReauthLoginUrl(redirect);
  });
}

function renderResetExecute($, escHtml, renderZkDialog, githubLogin, onCancelled) {
  renderZkDialog(
    'Confirm reset',
    `
      <p>GitHub verified. Delete all your encrypted data and set a new passphrase?</p>
      <p class="zk-error" id="zk-reset-error" hidden></p>
      <div class="zk-actions">
        <button type="button" class="consent-btn-secondary" id="zk-reset-abort">Cancel</button>
        <button type="button" class="consent-btn-primary" id="zk-reset-confirm">Reset and start over</button>
      </div>
    `,
  );

  const errorEl = $('zk-reset-error');
  const confirmBtn = $('zk-reset-confirm');

  $('zk-reset-abort')?.addEventListener('click', () => {
    clearZkResetPending();
    clearZkReauthProof();
    onCancelled?.();
  });

  confirmBtn?.addEventListener('click', async () => {
    errorEl.hidden = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Resetting…';
    try {
      await resetZkAccountAndReenroll(githubLogin);
    } catch (err) {
      if (err?.code === 'reauth_required' || err?.message === 'reauth_required') {
        errorEl.textContent = 'Verification expired — try again.';
        clearZkReauthProof();
      } else if (err?.code === 'rate_limited') {
        errorEl.textContent = 'Too many resets — try again later.';
      } else {
        errorEl.textContent = 'Reset failed. Try again.';
      }
      errorEl.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Reset and start over';
    }
  });
}

/**
 * Wire lost-passphrase UI into unlock gate helpers.
 * @param {{ $: (id: string) => HTMLElement|null, escHtml: (s: string) => string, renderZkDialog: Function }} ctx
 * @param {string} githubLogin
 */
export function wireZkResetUi(ctx, githubLogin, onCancelled) {
  const { $, escHtml, renderZkDialog } = ctx;

  if (isZkResetPending() && getZkReauthProof()) {
    renderResetExecute($, escHtml, renderZkDialog, githubLogin, onCancelled);
    return true;
  }

  if (isZkResetPending() && !getZkReauthProof()) {
    clearZkResetPending();
  }

  return false;
}

export function showLostPassphraseWarning(ctx, onCancelled) {
  const { $, escHtml, renderZkDialog } = ctx;
  renderResetWarning($, escHtml, renderZkDialog, onCancelled);
}