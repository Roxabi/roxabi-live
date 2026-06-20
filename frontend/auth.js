// auth.js — Server-owned onboarding gate (install → consent → ready)

import { renderOnboardingSteps } from "./onboarding.js";

const $ = (id) => document.getElementById(id);

export const DASHBOARD_PATH = "/dashboard";

const CONSENT_PREFIX = "roxabi:consent:";

/** Safe login URL with post-auth return path (defaults to dashboard). */
export function loginUrl(redirect = DASHBOARD_PATH) {
  return `/login?redirect=${encodeURIComponent(redirect)}`;
}

export class AuthError extends Error {
  constructor(msg = "Not authenticated") {
    super(msg);
    this.name = "AuthError";
  }
}

export async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (resp.status === 401) throw new AuthError();
  if (!resp.ok) throw new Error(`${path} ${resp.status}`);
  return resp;
}

/**
 * End session and navigate away.
 * @param {{ after?: "redirect" | "reload", to?: string }} [opts]
 */
export async function signOut(opts = {}) {
  const { after = "redirect", to = "/" } = opts;
  await api("/logout", { method: "POST" }).catch(() => {});
  if (after === "reload") location.reload();
  else location.href = to;
}

/** @deprecated localStorage bridge — removed after one release */
function hasLegacyConsent(login) {
  return Boolean(localStorage.getItem(CONSENT_PREFIX + login));
}

function clearLegacyConsent(login) {
  localStorage.removeItem(CONSENT_PREFIX + login);
}

async function migrateLegacyConsent(me) {
  const login = me.user.github_login;
  if (me.onboarding_step !== "consent" || !hasLegacyConsent(login)) return me;
  try {
    await api("/api/consent", { method: "POST" });
    clearLegacyConsent(login);
    return fetchMe();
  } catch {
    return me;
  }
}

async function fetchMe() {
  const resp = await api("/api/me");
  return resp.json();
}

export async function getSessionProfile() {
  return fetchMe();
}

function showSessionLost() {
  const el = document.getElementById("error-msg");
  if (el) {
    el.hidden = false;
    el.textContent = "Session expirée. Rechargez la page ou reconnectez-vous depuis l’accueil.";
  }
}

function renderInstallOption(opt) {
  if (opt.kind === "picker") {
    return `
      <a class="install-option" href="${escHtml(opt.url)}" role="listitem">
        <span class="install-option-title">Organisation</span>
        <span class="install-option-name">Choisir sur GitHub</span>
        <span class="install-option-hint">GitHub liste les organisations où vous pouvez installer l'app</span>
      </a>`;
  }
  const title = opt.kind === "personal" ? "Compte personnel" : "Organisation";
  const hint =
    opt.kind === "personal"
      ? "Vos dépôts uniquement — idéal en solo"
      : "Installer sur cette org — tous les dépôts ou une sélection sur GitHub";
  return `
    <a class="install-option" href="${escHtml(opt.url)}" role="listitem">
      <span class="install-option-title">${title}</span>
      <span class="install-option-name">${escHtml(opt.login ?? "")}</span>
      <span class="install-option-hint">${hint}</span>
    </a>`;
}

/** @returns {{ linked: object|null, oauthFallback: string }} */
export async function pollInstallRefresh(maxAttempts = 20) {
  let oauthFallback = "/login?intent=install&redirect=%2Fdashboard";
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch("/api/install/refresh", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (resp.status === 401) throw new AuthError();
    if (resp.status === 200) return { linked: await resp.json(), oauthFallback };
    if (resp.status === 202) {
      const body = await resp.json().catch(() => ({}));
      if (body.oauth_fallback) oauthFallback = body.oauth_fallback;
      await new Promise((r) => setTimeout(r, body.retry_after_ms ?? 2000));
      continue;
    }
    throw new Error(`/api/install/refresh ${resp.status}`);
  }
  return { linked: null, oauthFallback };
}

export function onboardingStepFromMe(me) {
  const step = me?.onboarding_step;
  if (step === "install" || step === "consent" || step === "ready") return step;
  throw new Error("invalid onboarding_step");
}

function renderInstallCta(me) {
  document.body.classList.add("gated");
  const el = $("auth-install");
  const login = escHtml(me.user.github_login);
  const options = (me.install_options ?? []).map(renderInstallOption).join("");

  el.innerHTML = `
    ${renderOnboardingSteps("install")}
    <div class="install-panel">
      <h2>Installer Roxabi Live sur GitHub</h2>
      <p class="install-lead">
        Connecté en tant que <strong>${login}</strong> (étape&nbsp;1 terminée).
        Choisissez où installer l'application&nbsp;: compte personnel, organisation,
        ou dépôts sélectionnés uniquement.
      </p>
      <div class="install-options" role="list">
        ${options}
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
        <button type="button" class="auth-login-btn" id="install-continue">J'ai installé — continuer</button>
      </div>
      <p class="install-note" id="install-refresh-hint" hidden></p>
    </div>
  `;
  el.removeAttribute("hidden");

  el.querySelector(".install-option[href]")?.focus();

  $("install-logout")?.addEventListener("click", () => signOut({ to: "/" }));

  $("install-continue")?.addEventListener("click", async () => {
    const btn = $("install-continue");
    const hint = $("install-refresh-hint");
    btn.disabled = true;
    btn.textContent = "Vérification…";
    try {
      const { linked, oauthFallback } = await pollInstallRefresh();
      if (linked?.onboarding_step) {
        location.reload();
        return;
      }
      if (hint) {
        hint.hidden = false;
        const fallback = escHtml(oauthFallback);
        hint.innerHTML = `Installation pas encore détectée après plusieurs tentatives. Réessayez ou <a href="${fallback}">reconnectez-vous via GitHub</a>.`;
      }
    } catch (e) {
      if (hint) {
        hint.hidden = false;
        hint.textContent =
          e instanceof AuthError
            ? "Session expirée — rechargez la page ou reconnectez-vous."
            : "Erreur réseau — réessayez dans un instant.";
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "J'ai installé — continuer";
    }
  });
}

function renderConsentGate(me) {
  return new Promise((resolve) => {
    document.body.classList.add("gated");
    const el = $("consent-gate");
    el.innerHTML = `
      ${renderOnboardingSteps("consent")}
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
        <p class="consent-error" id="consent-error" hidden role="alert"></p>
        <div class="consent-actions">
          <button class="consent-btn-secondary" id="consent-logout">Se déconnecter</button>
          <button class="consent-btn-primary" id="consent-ack">J'ai compris — lancer la synchronisation</button>
        </div>
      </div>
    `;
    el.removeAttribute("hidden");

    const ackBtn = $("consent-ack");
    const logoutBtn = $("consent-logout");
    ackBtn.focus();

    el.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey) {
        if (document.activeElement === logoutBtn) {
          e.preventDefault();
          ackBtn.focus();
        }
      } else if (document.activeElement === ackBtn) {
        e.preventDefault();
        logoutBtn.focus();
      }
    });

    ackBtn.addEventListener("click", async () => {
      ackBtn.disabled = true;
      const errEl = $("consent-error");
      if (errEl) errEl.hidden = true;
      try {
        await api("/api/consent", { method: "POST" });
        clearLegacyConsent(me.user.github_login);
        el.setAttribute("hidden", "");
        resolve();
      } catch {
        ackBtn.disabled = false;
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = "Enregistrement impossible — vérifiez votre connexion et réessayez.";
        }
      }
    });

    logoutBtn.addEventListener("click", () => signOut({ after: "reload" }));
  });
}

function renderOrgPicker(me) {
  const sel = $("org-picker");
  if (me.installations.length <= 1) {
    sel.setAttribute("hidden", "");
    return;
  }
  sel.innerHTML = "";
  for (const inst of me.installations) {
    const opt = document.createElement("option");
    opt.value = inst.tenant_id;
    opt.textContent = inst.account_login;
    sel.appendChild(opt);
  }
  if (me.active_tenant_id != null) sel.value = String(me.active_tenant_id);
  sel.removeAttribute("hidden");

  sel.addEventListener("change", async () => {
    const id = Number(sel.value);
    try {
      await api("/api/active-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: id }),
      });
      location.reload();
    } catch {
      if (me.active_tenant_id != null) sel.value = String(me.active_tenant_id);
    }
  });
}

async function wireUserMenu(me) {
  const { wireUserMenu: mount } = await import("./user-menu.js");
  mount(me);
}

export function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function isZkAccountKeyEnabled(me) {
  return me?.user?.zk_account_key_enabled === true;
}

/**
 * Server-owned onboarding gate.
 * @returns {Promise<'landing'|'install'|'consent'|'ready'>}
 */
export async function requireAuthGate() {
  let me;
  try {
    me = await fetchMe();
  } catch (e) {
    if (e instanceof AuthError) {
      showSessionLost();
      return "landing";
    }
    throw e;
  }

  me = await migrateLegacyConsent(me);
  let step;
  try {
    step = onboardingStepFromMe(me);
  } catch {
    showSessionLost();
    return "landing";
  }

  if (step === "install") {
    renderInstallCta(me);
    return "install";
  }

  if (step === "consent") {
    await renderConsentGate(me);
    document.body.classList.remove("gated");
    renderOrgPicker(me);
    await wireUserMenu(me);
    return "ready";
  }

  document.body.classList.remove("gated");
  renderOrgPicker(me);
  await wireUserMenu(me);
  return "ready";
}
