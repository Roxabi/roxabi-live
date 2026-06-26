/**
 * SettingsUi — shared open/resume state for the Settings dialog so the avatar
 * menu (UserMenu) and the OAuth-reauth resume both drive the same instance.
 * On mount (once URL handoff/reauth params are consumed) it reads ?settings=
 * and, when a privileged action returns with a fresh proof, opens Settings to
 * the passphrase form or re-runs the delete. Ported from resumeSettingsFromUrl.
 */

import { useZkRuntime } from "@/zk/ZkSessionProvider";
import { consumeSettingsResume } from "@/zk/settingsReauth";
import { createContext, useContext, useEffect, useRef, useState } from "react";

interface SettingsUiValue {
  open: boolean;
  openSettings: () => void;
  /** Close + clear any resume flags so a manual reopen starts clean. */
  setOpen: (open: boolean) => void;
  initialPassphraseForm: boolean;
  autoDelete: boolean;
  clearResumeFlags: () => void;
}

const SettingsUiContext = createContext<SettingsUiValue | null>(null);

export function useSettingsUi(): SettingsUiValue {
  const ctx = useContext(SettingsUiContext);
  if (!ctx) throw new Error("useSettingsUi must be used within SettingsUiProvider");
  return ctx;
}

export function SettingsUiProvider({ children }: { children: React.ReactNode }) {
  const { urlConsumed } = useZkRuntime();
  const [open, setOpenState] = useState(false);
  const [initialPassphraseForm, setInitialPassphraseForm] = useState(false);
  const [autoDelete, setAutoDelete] = useState(false);
  const resumed = useRef(false);

  useEffect(() => {
    if (!urlConsumed || resumed.current) return;
    resumed.current = true;
    const r = consumeSettingsResume();
    if (r.openSettings) {
      setInitialPassphraseForm(r.showPassphraseForm);
      setAutoDelete(r.runDelete);
      setOpenState(true);
    }
  }, [urlConsumed]);

  const clearResumeFlags = () => {
    setInitialPassphraseForm(false);
    setAutoDelete(false);
  };

  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) clearResumeFlags();
  };

  return (
    <SettingsUiContext.Provider
      value={{
        open,
        openSettings: () => setOpenState(true),
        setOpen,
        initialPassphraseForm,
        autoDelete,
        clearResumeFlags,
      }}
    >
      {children}
    </SettingsUiContext.Provider>
  );
}
