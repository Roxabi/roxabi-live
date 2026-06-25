// settingsReauth.ts — OAuth step-up handoff for the privileged settings actions
// (passphrase change / account delete). Port of the SETTINGS_ACTION_KEY +
// resumeSettingsFromUrl dance in frontend/settings.js. A pending action is parked
// in sessionStorage, the browser bounces through /login?reauth=1, and on return
// ?settings=<action> + a fresh reauth proof resume the action.

import { getZkReauthProof, zkReauthLoginUrl } from "./github";

const SETTINGS_ACTION_KEY = "roxabi:settings-pending-action";

export type SettingsAction = "passphrase" | "delete";

/** Park the intent + redirect through OAuth step-up, returning to ?settings=<action>. */
export function requestSettingsReauth(action: SettingsAction, returnPath = "/"): void {
  sessionStorage.setItem(SETTINGS_ACTION_KEY, action);
  const sep = returnPath.includes("?") ? "&" : "?";
  window.location.href = zkReauthLoginUrl(`${returnPath}${sep}settings=${action}`);
}

export interface SettingsResume {
  openSettings: boolean;
  showPassphraseForm: boolean;
  runDelete: boolean;
}

const NONE: SettingsResume = { openSettings: false, showPassphraseForm: false, runDelete: false };

function stripSettingsParam(params: URLSearchParams): void {
  params.delete("settings");
  const qs = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
  );
}

/** Read ?settings= once, strip it, return what to resume. Mirrors resumeSettingsFromUrl. */
export function consumeSettingsResume(): SettingsResume {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("settings");
  if (!tab) return NONE;

  if (tab === "open") {
    stripSettingsParam(params);
    return { openSettings: true, showPassphraseForm: false, runDelete: false };
  }

  const action = sessionStorage.getItem(SETTINGS_ACTION_KEY);
  sessionStorage.removeItem(SETTINGS_ACTION_KEY);
  if (!getZkReauthProof()) return NONE;

  stripSettingsParam(params);

  if (tab === "passphrase" && action === "passphrase") {
    return { openSettings: true, showPassphraseForm: true, runDelete: false };
  }
  if (tab === "delete" && action === "delete") {
    return { openSettings: true, showPassphraseForm: false, runDelete: true };
  }
  return NONE;
}
