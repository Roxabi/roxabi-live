/**
 * UserMenu — avatar trigger + account dropdown (Settings / Sign out).
 * Ported from frontend/user-menu.js. The GitHub avatar is loaded from the
 * public github.com/<login>.png endpoint, same as the vanilla app.
 */

import { useAuth } from "@/auth/AuthContext";
import { SettingsDialog } from "@/auth/SettingsDialog";
import { useSettingsUi } from "@/auth/SettingsUi";
import { getDisplayName } from "@/auth/displayName";
import { useLogout } from "@/auth/useAuthMutations";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/i18n";
import { Gear, SignOut } from "@phosphor-icons/react";
import { useState } from "react";

export function UserMenu() {
  const t = useT();
  const me = useAuth();
  const logout = useLogout();
  const settings = useSettingsUi();
  const [open, setOpen] = useState(false);
  const login = me.user.github_login;
  const [name, setName] = useState(() => getDisplayName(login));

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          title={name}
          aria-label={t("auth.userMenu.trigger")}
          data-testid="user-menu-trigger"
          className="flex size-9 items-center justify-center overflow-hidden rounded-full border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img
            src={`https://github.com/${encodeURIComponent(login)}.png?size=64`}
            alt={login}
            className="size-full object-cover"
          />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-1">
          <div className="border-b border-border px-3 py-2">
            <div className="truncate text-sm font-medium text-foreground">{name}</div>
            <div className="truncate text-xs text-muted-foreground">@{login}</div>
          </div>
          <button
            type="button"
            data-testid="user-menu-settings"
            onClick={() => {
              setOpen(false);
              settings.openSettings();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-foreground hover:bg-card"
          >
            <Gear className="size-4" aria-hidden />
            {t("auth.userMenu.settings")}
          </button>
          <button
            type="button"
            data-testid="user-menu-signout"
            onClick={() => {
              setOpen(false);
              logout.mutate({ to: "/" });
            }}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-foreground hover:bg-card"
          >
            <SignOut className="size-4" aria-hidden />
            {t("auth.userMenu.signOut")}
          </button>
        </PopoverContent>
      </Popover>
      <SettingsDialog
        me={me}
        open={settings.open}
        onOpenChange={settings.setOpen}
        onNameChange={setName}
        initialPassphraseForm={settings.initialPassphraseForm}
        autoDelete={settings.autoDelete}
        onResumeHandled={settings.clearResumeFlags}
      />
    </>
  );
}
