/**
 * SignInScreen — public sign-in / sign-up entry (GitHub OAuth).
 * Ported from frontend/auth-pages.js: builds /login?intent=signin&redirect=…
 * with an optional remember-session flag persisted to localStorage.
 */

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { GithubLogo } from "@phosphor-icons/react";
import { useState } from "react";

const DASHBOARD_PATH = "/dashboard";
const REMEMBER_SESSION_KEY = "roxabi:remember_session";

function safeRedirect(raw: string | null): string {
  const c = raw?.trim();
  if (c && /^\/(?![/\\])/.test(c) && !/[\r\n\0]/.test(c) && !/["'<>]/.test(c)) return c;
  return DASHBOARD_PATH;
}

function loginUrl(remember: boolean): string {
  const redirect = safeRedirect(new URLSearchParams(location.search).get("redirect"));
  const params = new URLSearchParams({ intent: "signin", redirect });
  if (remember) params.set("remember", "1");
  return `/login?${params}`;
}

export function SignInScreen({
  mode = "signin",
  reason,
}: {
  mode?: "signin" | "signup";
  reason?: "session-lost";
}) {
  const t = useT();
  const [remember, setRemember] = useState(
    () => localStorage.getItem(REMEMBER_SESSION_KEY) === "1",
  );

  function onRememberChange(checked: boolean) {
    setRemember(checked);
    localStorage.setItem(REMEMBER_SESSION_KEY, checked ? "1" : "0");
  }

  const isSignup = mode === "signup";

  return (
    <div className="flex min-h-[60vh] items-center justify-center" data-testid="signin-screen">
      <div className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-8">
        <h1 className="text-xl font-semibold text-foreground">
          {isSignup ? t("auth.signup.title") : t("auth.signin.title")}
        </h1>
        {reason === "session-lost" && (
          <p className="rounded-md border border-blocked/30 bg-blocked/10 px-3 py-2 text-sm text-blocked">
            {t("auth.sessionLost")}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {t("auth.signin.description")}
        </p>
        <Button asChild className="w-full">
          <a href={loginUrl(remember)} data-testid="github-login">
            <GithubLogo className="size-5" weight="fill" aria-hidden />
            <span>{isSignup ? t("auth.signup.githubButton") : t("auth.signin.githubButton")}</span>
          </a>
        </Button>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => onRememberChange(e.target.checked)}
            className="size-4 rounded border-border"
          />
          {t("auth.signin.rememberMe")}
        </label>
      </div>
    </div>
  );
}
