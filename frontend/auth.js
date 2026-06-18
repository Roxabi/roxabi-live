// auth.js — Auth gate state machine, consent persistence, API wrapper
// Exports: AuthError, api, hasConsent, setConsent, resolveView, requireAuthGate, getSessionProfile

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
  if (me.installations.length === 0) return 'install';
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

function renderInstallCta() {
  document.body.classList.add('gated');
  const el = $('auth-install');
  el.innerHTML = `
    <h2>Install the GitHub App</h2>
    <p>No GitHub App installation found for your account. Install the Roxabi Live app on your organisation to get started.</p>
    <a
      href="https://github.com/apps/roxabi-live/installations/new"
      class="auth-login-btn"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Install GitHub App"
    >Install GitHub App</a>
    <p><small>After installing, reload this page.</small></p>
  `;
  el.removeAttribute('hidden');
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
          <strong>During this phase, the operator can read the issue data of the organisations you grant.</strong>
          Don't paste secrets into issue bodies or titles.
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

async function enableZkMode(me) {
  const graphResp = await api('/api/graph');
  const { nodes } = await graphResp.json();
  const { sealGraphTitles } = await import('./zk-sync.js');
  await sealGraphTitles(nodes ?? [], me.user.github_login);
  await api('/api/zk-opt-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  location.reload();
}

function renderOperatorNotice(me) {
  const el = $('operator-notice');
  const zkOn = Boolean(me.user.zk_opt_in);
  el.innerHTML = `
    <div class="operator-notice-main">
      <strong>Operator read access (this phase):</strong> the operator can read the issue data of the organisations you grant.
      Don't paste secrets into issue bodies or titles.
      <a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">Manage</a>
    </div>
    <div class="zk-opt-in-panel">
      <label class="zk-opt-in-label">
        <input type="checkbox" id="zk-opt-in-toggle" ${zkOn ? 'checked' : ''} />
        Private mode (beta) — encrypt issue content client-side
      </label>
      <p class="zk-opt-in-hint" id="zk-opt-in-hint" ${zkOn ? '' : 'hidden'}>
        <strong>Scope:</strong> content only, not structure. Issue state, blocker edges, and counts stay visible to the operator.
        Titles and bodies are encrypted client-side; keys stay in this browser.
        <a href="/login?zk=1" id="zk-github-link">Link GitHub</a> to sync issue bodies.
      </p>
    </div>
  `;
  el.removeAttribute('hidden');

  const toggle = $('zk-opt-in-toggle');
  const hint = $('zk-opt-in-hint');
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      if (enabled) {
        await enableZkMode(me);
        return;
      }
      await api('/api/zk-opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      location.reload();
    } catch {
      toggle.checked = !enabled;
      toggle.disabled = false;
    }
  });
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
    renderInstallCta();
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
