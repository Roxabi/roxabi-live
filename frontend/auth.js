// auth.js — Auth gate state machine, consent persistence, API wrapper
// Exports: AuthError, api, hasConsent, setConsent, resolveView, requireAuthGate, getSessionProfile

import { githubInstallUrl, partitionInstallTargets } from './github-install.js';

const $ = id => document.getElementById(id);

// ─── AuthError ────────────────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(msg = 'Not authenticated') {
    super(msg);
    this.name = 'AuthError';
  }
}

// ─── API wrapper ──────────────────────────────────────────────────────────────

/** fetch wrapper — throws AuthError on 401, Error on other non-ok responses. */
export async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (resp.status === 401) throw new AuthError();
  if (!resp.ok) throw new Error(`${path} ${resp.status}`);
  return resp;
}

// ─── Consent persistence ──────────────────────────────────────────────────────

const CONSENT_PREFIX = 'roxabi:consent:';

/** Returns true if the user has previously acknowledged the operator-read consent. */
export function hasConsent(login) {
  return Boolean(localStorage.getItem(CONSENT_PREFIX + login));
}

/** Persists consent acknowledgement for this login (ISO timestamp). */
export function setConsent(login) {
  localStorage.setItem(CONSENT_PREFIX + login, new Date().toISOString());
}

// ─── View resolution (pure) ───────────────────────────────────────────────────

/**
 * Resolve which view to show.
 * Pure: no DOM, no storage, no fetch — call sites handle side-effects.
 *
 * @param {{ user: { github_id: number, github_login: string }, active_tenant_id: number|null, installations: Array<{ tenant_id: number, account_login: string, account_type: string }> }} me
 * @param {boolean} consented
 * @returns {'install'|'consent'|'dashboard'}
 */
export function resolveView(me, consented) {
  if (me.install_pending || me.installations.length === 0) return 'install';
  if (!consented) return 'consent';
  return 'dashboard';
}

// ─── Internal: /api/me ────────────────────────────────────────────────────────

/** Fetches /api/me. Throws AuthError if 401 (no session). */
async function fetchMe() {
  const resp = await api('/api/me');
  return resp.json();
}

/** Session profile from /api/me — for dashboard bootstrap after auth gate. */
export async function getSessionProfile() {
  return fetchMe();
}

/** True when server exposes ZK_ACCOUNT_KEY feature (#216 PR 1b). */
export function isZkAccountKeyEnabled(me) {
  return me?.user?.zk_account_key_enabled === true;
}

// ─── Internal: render landing ─────────────────────────────────────────────────

function renderLanding() {
  document.body.classList.add('gated');
  const el = $('auth-landing');
  el.innerHTML = `
    <h2>Welcome to Roxabi Live</h2>
    <p>Sign in with GitHub to view your organisation's dependency graph.</p>
    <a href="/login" class="auth-login-btn" aria-label="Sign in with GitHub">Sign in with GitHub</a>
  `;
  el.removeAttribute('hidden');
}

// ─── Internal: render install CTA ────────────────────────────────────────────

/**
 * @param {{ user: { github_id: number, github_login: string }, install_targets?: Array<{ id: number, login: string, type: string }> }} me
 */
function renderInstallCta(me) {
  document.body.classList.add('gated');
  const el = $('auth-install');
  const targets = me.install_targets ?? [];
  const { personal, orgs } = partitionInstallTargets(targets);
  const login = escHtml(me.user.github_login);

  const personalUrl = personal ? githubInstallUrl(personal) : githubInstallUrl();
  const orgCards = orgs.length
    ? orgs.map(org => `
        <a
          class="install-option"
          href="${escHtml(githubInstallUrl(org))}"
          role="listitem"
        >
          <span class="install-option-title">Organisation</span>
          <span class="install-option-name">${escHtml(org.login)}</span>
          <span class="install-option-hint">Install on this org — choose all repos or selected repos on GitHub</span>
        </a>
      `).join('')
    : `
        <a
          class="install-option"
          href="${escHtml(githubInstallUrl())}"
          role="listitem"
        >
          <span class="install-option-title">Organisation</span>
          <span class="install-option-name">Pick on GitHub</span>
          <span class="install-option-hint">GitHub will show every org where you can install or request access</span>
        </a>
      `;

  el.innerHTML = `
    <div class="install-panel">
      <h2>Install Roxabi Live on GitHub</h2>
      <p class="install-lead">
        Signed in as <strong>${login}</strong>. Choose where to install the app.
        GitHub handles permissions and repository access — you can install on your
        personal account, an organisation, or limit access to specific repositories.
      </p>
      <div class="install-options" role="list">
        <a
          class="install-option"
          href="${escHtml(personalUrl)}"
          role="listitem"
        >
          <span class="install-option-title">Personal account</span>
          <span class="install-option-name">${login}</span>
          <span class="install-option-hint">Your repos only — good for solo projects</span>
        </a>
        ${orgCards}
        <div class="install-option install-option-info" role="listitem">
          <span class="install-option-title">Specific repositories only</span>
          <span class="install-option-hint">
            Pick an account above, then on GitHub choose <strong>Only select repositories</strong>
            and select the repos you want Roxabi Live to read.
          </span>
        </div>
      </div>
      <p class="install-note">
        You'll be taken to GitHub to choose repositories, then brought back here
        automatically. If GitHub doesn't return you, come back and click
        <strong>Continue</strong>.
      </p>
      <div class="install-actions">
        <button type="button" class="consent-btn-secondary" id="install-logout">Sign out</button>
        <a href="/login?redirect=/" class="auth-login-btn" id="install-continue">I've installed — continue</a>
      </div>
    </div>
  `;
  el.removeAttribute('hidden');

  const firstInstallLink = el.querySelector('.install-option[href]');
  firstInstallLink?.focus();

  $('install-logout')?.addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });

  const pageUrl = new URL(location.href);
  if (pageUrl.searchParams.has('install')) {
    pageUrl.searchParams.delete('install');
    history.replaceState(null, '', pageUrl.pathname + pageUrl.search + pageUrl.hash);
  }
}

// ─── Internal: render consent gate ───────────────────────────────────────────

/**
 * Renders the consent overlay and resolves when the user acknowledges.
 * @param {{ user: { github_id: number, github_login: string }, active_tenant_id: number|null, installations: Array<{ tenant_id: number, account_login: string, account_type: string }> }} me
 * @returns {Promise<void>} resolves on ACK
 */
function renderConsentGate(me) {
  return new Promise(resolve => {
    document.body.classList.add('gated');
    const el = $('consent-gate');
    el.innerHTML = `
      <div class="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <h2 id="consent-title">Operator data access</h2>
        <p>
          Roxabi Live reads your GitHub organisation data on your behalf to build
          the dependency graph. The following access is required:
        </p>
        <div class="consent-scopes">
          <div class="consent-scope-item">Read issues, labels, milestones, and sub-issue relationships</div>
          <div class="consent-scope-item">Read repository metadata (name, visibility, archived status)</div>
          <div class="consent-scope-item">Data is stored in Cloudflare D1 and scoped to your organisation</div>
        </div>
        <p>
          Signed in as <strong>${escHtml(me.user.github_login)}</strong>.
          You can revoke access at any time from your
          <a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">GitHub App settings</a>.
        </p>
        <p class="consent-warning">
          <strong>Issue titles and bodies are encrypted client-side before storage.</strong>
          Graph structure (state, blockers, labels) remains visible to the operator.
        </p>
        <div class="consent-actions">
          <button class="consent-btn-secondary" id="consent-logout">Sign out</button>
          <button class="consent-btn-primary" id="consent-ack">I understand — continue</button>
        </div>
      </div>
    `;
    el.removeAttribute('hidden');

    const ackBtn = $('consent-ack');
    const logoutBtn = $('consent-logout');

    // F3: focus first interactive element after show
    ackBtn.focus();

    // F3: Tab trap — cycle between logoutBtn and ackBtn only
    el.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === logoutBtn) {
          e.preventDefault();
          ackBtn.focus();
        }
      } else {
        if (document.activeElement === ackBtn) {
          e.preventDefault();
          logoutBtn.focus();
        }
      }
    });

    ackBtn.addEventListener('click', () => {
      setConsent(me.user.github_login);
      el.setAttribute('hidden', '');
      resolve();
    });

    // F6: route through api() instead of bare fetch
    logoutBtn.addEventListener('click', async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      location.reload();
    });
  });
}

// ─── Internal: render org picker ─────────────────────────────────────────────

function renderOrgPicker(me) {
  const sel = $('org-picker');
  if (me.installations.length <= 1) { sel.setAttribute('hidden', ''); return; }
  sel.innerHTML = '';
  for (const inst of me.installations) {
    const opt = document.createElement('option');
    opt.value = inst.tenant_id;
    opt.textContent = inst.account_login;
    sel.appendChild(opt);
  }
  if (me.active_tenant_id != null) sel.value = String(me.active_tenant_id);
  sel.removeAttribute('hidden');

  sel.addEventListener('change', async () => {
    const id = Number(sel.value);
    try {
      await api('/api/active-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: id }),
      });
      location.reload();
    } catch {
      // revert selection to last known active tenant
      if (me.active_tenant_id != null) sel.value = String(me.active_tenant_id);
    }
  });
}

// ─── Internal: render operator notice ────────────────────────────────────────

function renderOperatorNotice(_me) {
  const el = $('operator-notice');
  el.innerHTML = `
    <div class="operator-notice-main">
      <strong>Private mode is always on.</strong>
      Issue titles and bodies are encrypted in your browser before they are stored.
      Graph structure (state, blockers, milestones) stays visible to the operator.
      <a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">Manage app access</a>
    </div>
    <p class="zk-opt-in-hint">
      <a href="/login?zk=1" id="zk-github-link">Link GitHub</a>
      to sync issue bodies on this device (token is kept in this tab only).
      When passphrase backup is enabled, unlock first to seal or decrypt content.
    </p>
    <p class="zk-opt-in-hint">
      Each teammate encrypts their own view of issue titles.
      You will see <strong>(sealed)</strong> on issues another teammate sealed until you link GitHub and sync.
    </p>
  `;
  el.removeAttribute('hidden');
}

// ─── Internal: wire logout ────────────────────────────────────────────────────

function wireLogout() {
  const btn = $('logout-btn');
  btn.removeAttribute('hidden');
  btn.addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
}

// ─── Internal: escape HTML ────────────────────────────────────────────────────

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ─── requireAuthGate (async orchestrator) ─────────────────────────────────────

/**
 * Runs the full auth gate flow.
 *
 * SC1 render-block: callers MUST check the returned view and skip
 * fetch('/api/graph') (and all other /api/* data calls) until this returns
 * 'dashboard'. This is a frontend render-gate, NOT an authz boundary — the
 * server already scopes /api/* to the active session+tenant. The gate here
 * exists so the UI never fires graph data fetches for unauthenticated or
 * unconsented users, which would produce confusing 401/empty-graph errors.
 *
 * @returns {Promise<'landing'|'install'|'consent'|'dashboard'>}
 */
export async function requireAuthGate() {
  let me;
  try {
    me = await fetchMe();
  } catch (e) {
    if (e instanceof AuthError) {
      renderLanding();
      return 'landing';
    }
    throw e;
  }

  const consented = hasConsent(me.user.github_login);
  const view = resolveView(me, consented);

  if (view === 'install') {
    renderInstallCta(me);
    return 'install';
  }

  if (view === 'consent') {
    await renderConsentGate(me);
    // After ACK, remove gate class and wire persistent UI before returning 'dashboard'
    document.body.classList.remove('gated');
    renderOrgPicker(me);
    renderOperatorNotice(me);
    wireLogout();
    return 'dashboard';
  }

  // view === 'dashboard': already consented, wire persistent UI immediately
  document.body.classList.remove('gated');
  renderOrgPicker(me);
  renderOperatorNotice(me);
  wireLogout();
  return 'dashboard';
}
