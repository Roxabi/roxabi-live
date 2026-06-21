// settings.js — account settings panel

import { DASHBOARD_PATH, api, escHtml, signOut } from "./auth.js";
import { applyThemePref, getThemePref, setThemePref } from "./theme.js";
import {
  rewrapAccountKeyBackup,
  saveDeviceSession,
  sessionAccountKey,
  unwrapAccountKey,
} from "./zk-crypto.js";
import { updateKeyBackup } from "./zk-enroll.js";
import { getZkReauthProof, zkReauthLoginUrl } from "./zk-github.js";
import { clearLocalZkState } from "./zk-reset.js";
import { setZkSession } from "./zk-session.js";

const $ = (id) => document.getElementById(id);

const DISPLAY_NAME_PREFIX = "roxabi:display-name:";
const SETTINGS_ACTION_KEY = "roxabi:settings-pending-action";

export function getDisplayName(login) {
  return localStorage.getItem(DISPLAY_NAME_PREFIX + login) || login;
}

export function setDisplayName(login, name) {
  const trimmed = name.trim();
  if (!trimmed || trimmed === login) {
    localStorage.removeItem(DISPLAY_NAME_PREFIX + login);
    return login;
  }
  localStorage.setItem(DISPLAY_NAME_PREFIX + login, trimmed);
  return trimmed;
}

/**
 * @param {{ user: { github_login: string, zk_enrolled?: boolean, zk_account_key_enabled?: boolean }, installations?: Array<{ tenant_id: number, account_login: string, account_type: string }>, install_targets?: Array<{ id: number, login: string, type: string }> }} me
 */
export function openSettings(me) {
  const gate = $("settings-gate");
  if (!gate) return;

  const login = me.user.github_login;
  const displayName = getDisplayName(login);
  const themePref = getThemePref();
  const installations = me.installations ?? [];
  const installUrl =
    (me.install_options ?? []).find((o) => o.kind === "personal")?.url ??
    (me.install_options ?? []).find((o) => o.kind === "picker")?.url ??
    (me.install_options ?? [])[0]?.url ??
    null;

  gate.innerHTML = `
    <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <h2 id="settings-title">Settings</h2>
        <button type="button" class="settings-close" id="settings-close" aria-label="Close">×</button>
      </header>
      <div class="settings-body">
        <section class="settings-section">
          <h3>Profile</h3>
          <label class="settings-field">
            <span>Display name</span>
            <input type="text" id="settings-display-name" value="${escHtml(displayName)}" autocomplete="name" maxlength="64" />
          </label>
          <p class="settings-hint">Shown in the header. GitHub login: <strong>${escHtml(login)}</strong>.</p>
        </section>

        <section class="settings-section">
          <h3>Appearance</h3>
          <label class="settings-field">
            <span>Default theme</span>
            <select id="settings-theme">
              <option value="auto" ${themePref === "auto" ? "selected" : ""}>Auto (system)</option>
              <option value="light" ${themePref === "light" ? "selected" : ""}>Light</option>
              <option value="dark" ${themePref === "dark" ? "selected" : ""}>Dark</option>
            </select>
          </label>
        </section>

        ${
          me.user.zk_account_key_enabled
            ? `
        <section class="settings-section">
          <h3>Encryption</h3>
          <p class="settings-hint">Change the passphrase protecting your server-side encryption backup.</p>
          <button type="button" class="settings-action-btn" id="settings-change-pass">Change passphrase</button>
          <div id="settings-pass-form" class="settings-pass-form" hidden>
            <label class="settings-field">
              <span>Current passphrase</span>
              <input type="password" id="settings-pass-current" autocomplete="current-password" />
            </label>
            <label class="settings-field">
              <span>New passphrase</span>
              <input type="password" id="settings-pass-new" autocomplete="new-password" minlength="8" />
            </label>
            <label class="settings-field">
              <span>Confirm new passphrase</span>
              <input type="password" id="settings-pass-confirm" autocomplete="new-password" minlength="8" />
            </label>
            <p class="settings-error" id="settings-pass-error" hidden></p>
            <div class="settings-inline-actions">
              <button type="button" class="consent-btn-secondary" id="settings-pass-cancel">Cancel</button>
              <button type="button" class="consent-btn-primary" id="settings-pass-save">Save passphrase</button>
            </div>
          </div>
        </section>
        `
            : ""
        }

        <section class="settings-section">
          <h3>Repositories</h3>
          <p class="settings-hint">Add or remove repositories the GitHub App can access.</p>
          ${
            installations.length
              ? `<ul class="settings-list">${installations
                  .map(
                    (i) => `
              <li><strong>${escHtml(i.account_login)}</strong> <span class="settings-muted">(${escHtml(i.account_type)})</span></li>
            `,
                  )
                  .join("")}</ul>`
              : '<p class="settings-muted">No installation linked yet.</p>'
          }
          <a class="settings-link-btn" href="${escHtml(installUrl)}" target="_blank" rel="noopener noreferrer">Configure repositories on GitHub</a>
        </section>

        <section class="settings-section">
          <h3>GitHub App permissions</h3>
          <p class="settings-hint">Review or revoke Roxabi Live access on your GitHub account.</p>
          <a class="settings-link-btn" href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">Manage permissions on GitHub</a>
        </section>

        <section class="settings-section settings-danger">
          <h3>Delete account</h3>
          <p class="settings-hint">Wipes your Roxabi data and signs you out. Revoke the app on GitHub separately.</p>
          <button type="button" class="settings-danger-btn" id="settings-delete-account">Delete my data &amp; sign out</button>
        </section>
      </div>
    </div>
  `;

  gate.removeAttribute("hidden");
  document.body.classList.add("settings-open");

  const close = () => {
    gate.setAttribute("hidden", "");
    gate.innerHTML = "";
    document.body.classList.remove("settings-open");
  };

  $("settings-close")?.addEventListener("click", close);
  gate.addEventListener("click", (e) => {
    if (e.target === gate) close();
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });

  $("settings-display-name")?.addEventListener("change", (e) => {
    const name = setDisplayName(login, e.target.value);
    e.target.value = name;
    document.dispatchEvent(new CustomEvent("roxabi:display-name", { detail: { login, name } }));
  });

  $("settings-theme")?.addEventListener("change", (e) => {
    setThemePref(e.target.value);
    applyThemePref(e.target.value);
  });

  if (me.user.zk_account_key_enabled) {
    wirePassphraseChange(login, close);
  }

  $("settings-delete-account")?.addEventListener("click", () => {
    deleteAccountData(me, login);
  });

  return { close, showPassphraseForm: () => $("settings-pass-form")?.removeAttribute("hidden") };
}

/**
 * Wipe server + local Roxabi state and sign out.
 * @returns {Promise<boolean>} true when delete completed (caller should stop init)
 */
export async function deleteAccountData(me, login) {
  if (!confirm("Delete all your Roxabi Live data and sign out? This cannot be undone.")) {
    return false;
  }

  const payload = {};
  if (me.user.zk_enrolled) {
    const proof = getZkReauthProof();
    if (!proof) {
      sessionStorage.setItem(SETTINGS_ACTION_KEY, "delete");
      location.href = zkReauthLoginUrl(`${DASHBOARD_PATH}?settings=delete`);
      return true;
    }
    payload.reauth_proof = proof;
  }

  try {
    await api("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const code = err?.message?.includes("403") ? "reauth_required" : "delete_failed";
    if (code === "reauth_required") {
      sessionStorage.setItem(SETTINGS_ACTION_KEY, "delete");
      location.href = zkReauthLoginUrl(`${DASHBOARD_PATH}?settings=delete`);
      return true;
    }
    alert("Could not delete your data. Try again or use Lost passphrase to reset encryption.");
    return false;
  }

  clearZkReauthProof();
  await clearLocalZkState(login);
  localStorage.removeItem(DISPLAY_NAME_PREFIX + login);
  await signOut({ after: "reload" });
  return true;
}

function wirePassphraseChange(login, closeSettings) {
  const form = $("settings-pass-form");
  const errEl = $("settings-pass-error");

  $("settings-change-pass")?.addEventListener("click", () => {
    if (!getZkReauthProof()) {
      sessionStorage.setItem(SETTINGS_ACTION_KEY, "passphrase");
      location.href = zkReauthLoginUrl(`${DASHBOARD_PATH}?settings=passphrase`);
      return;
    }
    form?.removeAttribute("hidden");
  });

  $("settings-pass-cancel")?.addEventListener("click", () => {
    form?.setAttribute("hidden", "");
    if (errEl) errEl.hidden = true;
  });

  $("settings-pass-save")?.addEventListener("click", async () => {
    const current = $("settings-pass-current")?.value ?? "";
    const newPass = $("settings-pass-new")?.value ?? "";
    const confirm = $("settings-pass-confirm")?.value ?? "";
    if (errEl) errEl.hidden = true;

    if (newPass.length < 8) {
      errEl.textContent = "New passphrase must be at least 8 characters.";
      errEl.hidden = false;
      return;
    }
    if (newPass !== confirm) {
      errEl.textContent = "New passphrases do not match.";
      errEl.hidden = false;
      return;
    }

    const saveBtn = $("settings-pass-save");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
    }

    try {
      const resp = await api("/api/zk/key-backup");
      const backup = await resp.json();
      const wrapped = await rewrapAccountKeyBackup(current, newPass, backup);
      await updateKeyBackup(wrapped);
      const accountKey = await unwrapAccountKey(newPass, {
        kdf_params: wrapped.kdf_params,
        wrap_iv: wrapped.wrap_iv,
        wrapped_key: wrapped.wrapped_key,
      });
      const session = await sessionAccountKey(accountKey);
      setZkSession(session, wrapped.key_fp);
      await saveDeviceSession(login, accountKey, wrapped.key_fp);
      form?.setAttribute("hidden", "");
      closeSettings();
    } catch {
      if (errEl) {
        errEl.textContent = "Incorrect current passphrase or update failed.";
        errEl.hidden = false;
      }
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save passphrase";
      }
    }
  });
}

/** Resume settings flow after OAuth reauth redirect. */
export async function resumeSettingsFromUrl(me) {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("settings");
  if (!tab) return false;

  if (tab === "open") {
    params.delete("settings");
    const qs = params.toString();
    history.replaceState({}, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
    openSettings(me);
    return;
  }

  const action = sessionStorage.getItem(SETTINGS_ACTION_KEY);
  sessionStorage.removeItem(SETTINGS_ACTION_KEY);
  if (!getZkReauthProof()) return false;

  params.delete("settings");
  const qs = params.toString();
  history.replaceState({}, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);

  if (tab === "passphrase" && action === "passphrase") {
    const ui = openSettings(me);
    ui?.showPassphraseForm();
    return false;
  }
  if (tab === "delete" && action === "delete") {
    return deleteAccountData(me, me.user.github_login);
  }
  return false;
}
