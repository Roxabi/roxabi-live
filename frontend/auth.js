// auth.js — Auth gate state machine, consent persistence, API wrapper
// Exports: AuthError, api, hasConsent, setConsent, resolveView, requireAuthGate, getSessionProfile

import { githubInstallUrl, partitionInstallTargets } from './github-install.js';
import { renderOnboardingSteps } from './onboarding.js';

const $ = id => document.getElementById(id);

export const DASHBOARD_PATH = '/dashboard';

/** Safe login URL with post-auth return path (defaults to dashboard). */
export function loginUrl(redirect = DASHBOARD_PATH) {
  return `/login?redirect=${encodeURIComponent(redirect)}`;
}

/** Re-OAuth after GitHub App install — install=1 is a /login flag, not redirect=. */
export function refreshInstallLoginUrl(redirect = DASHBOARD_PATH) {
  return `/login?install=1&redirect=${encodeURIComponent(redirect)}`;
}

/** @deprecated Server gates /dashboard; client redirect causes OAuth loops. */
function showSessionLost() {
  const el = document.getElementById('error-msg');
  if (el) {
    el.hidden = false;
    el.textContent = 'Session expired. Reload the page or sign in again from the homepage.';
  }
}

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
          <span class="install-option-hint">Installer sur cette org — tous les dépôts ou une sélection sur GitHub</span>
        </a>
      `).join('')
    : `
        <a
          class="install-option"
          href="${escHtml(githubInstallUrl())}"
          role="listitem"
        >
          <span class="install-option-title">Organisation</span>
          <span class="install-option-name">Choisir sur GitHub</span>
          <span class="install-option-hint">GitHub liste les organisations où vous pouvez installer l'app</span>
        </a>
      `;

  el.innerHTML = `
    ${renderOnboardingSteps('install')}
    <div class="install-panel">
      <h2>Installer Roxabi Live sur GitHub</h2>
      <p class="install-lead">
        Connecté en tant que <strong>${login}</strong> (étape&nbsp;1 terminée).
        Choisissez où installer l'application&nbsp;: compte personnel, organisation,
        ou dépôts sélectionnés uniquement.
      </p>
      <div class="install-options" role="list">
        <a
          class="install-option"
          href="${escHtml(personalUrl)}"
          role="listitem"
        >
          <span class="install-option-title">Compte personnel</span>
          <span class="install-option-name">${login}</span>
          <span class="install-option-hint">Vos dépôts uniquement — idéal en solo</span>
        </a>
        ${orgCards}
        <div class="install-option install-option-info" role="listitem">
          <span class="install-option-title">Dépôts sélectionnés</span>
          <span class="install-option-hint">
            Choisissez un compte ci-dessus, puis sur GitHub&nbsp;:
            <strong>Only select repositories</strong> et sélectionnez les dépôts à synchroniser.
          </span>
        </div>
      </div>
      <p class="install-note">
        GitHub vous demandera quels dépôts autoriser, puis vous ramènera ici.
        Si la redirection échoue, revenez et cliquez
        <strong>J'ai installé — continuer</strong>.
      </p>
      <div class="install-actions">
        <button type="button" class="consent-btn-secondary" id="install-logout">Se déconnecter</button>
        <a href="${escHtml(refreshInstallLoginUrl(DASHBOARD_PATH))}" class="auth-login-btn" id="install-continue">J'ai installé — continuer</a>
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
      ${renderOnboardingSteps('consent')}
      <div class="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <h2 id="consent-title">Accès aux données</h2>
        <p>
          L'application est installée. Avant la première synchronisation, confirmez
          que Roxabi Live peut lire les métadonnées GitHub suivantes&nbsp;:
        </p>
        <div class="consent-scopes">
          <div class="consent-scope-item">Issues, labels, milestones et relations parent/enfant</div>
          <div class="consent-scope-item">Métadonnées des dépôts (nom, visibilité, archivage)</div>
          <div class="consent-scope-item">Données stockées dans Cloudflare D1, limitées à votre organisation</div>
        </div>
        <p>
          Connecté en tant que <strong>${escHtml(me.user.github_login)}</strong>.
          Vous pouvez révoquer l'accès depuis vos
          <a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">paramètres GitHub</a>.
        </p>
        <p class="consent-warning">
          <strong>Les titres et corps d'issues sont chiffrés côté client avant stockage.</strong>
          La structure du graphe (état, blockers, labels) reste lisible par l'opérateur.
        </p>
        <div class="consent-actions">
          <button class="consent-btn-secondary" id="consent-logout">Se déconnecter</button>
          <button class="consent-btn-primary" id="consent-ack">J'ai compris — lancer la synchronisation</button>
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

// ─── Internal: wire user menu (avatar dropdown) ───────────────────────────────

async function wireUserMenu(me) {
  const { wireUserMenu: mount } = await import('./user-menu.js');
  mount(me);
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
      showSessionLost();
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
    await wireUserMenu(me);
    return 'dashboard';
  }

  // view === 'dashboard': already consented, wire persistent UI immediately
  document.body.classList.remove('gated');
  renderOrgPicker(me);
  await wireUserMenu(me);
  return 'dashboard';
}
