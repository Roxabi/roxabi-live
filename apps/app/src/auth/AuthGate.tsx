/**
 * AuthGate — the server-owned onboarding gate, ported from frontend/auth.js
 * requireAuthGate(). Resolves GET /api/me, then routes:
 *
 *   401 / no session   → <SignInScreen/> (neutral — not "session expired")
 *   onboarding "install" → <InstallGate/>
 *   onboarding "consent" → <ConsentGate/>
 *   onboarding "ready"   → <AuthProvider> children
 *
 * Children (the dashboard + its data fetches) mount only once ready, so the
 * graph/sync queries never fire for an unauthenticated or half-onboarded user.
 */

import { AuthProvider } from "@/auth/AuthContext";
import { ConsentGate } from "@/auth/ConsentGate";
import { InstallGate } from "@/auth/InstallGate";
import { SignInScreen } from "@/auth/SignInScreen";
import { useMe } from "@/auth/useMe";
import { useT } from "@/i18n";
import { CircleNotch } from "@phosphor-icons/react";

function AuthLoading() {
  const t = useT();
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center text-muted-foreground"
      data-testid="auth-loading"
    >
      <CircleNotch className="size-6 animate-spin" aria-hidden />
      <span className="sr-only">{t("auth.loading.srOnly")}</span>
    </div>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const { data: me, isLoading, error } = useMe();

  if (isLoading) return <AuthLoading />;

  if (error) {
    if (error.status === 401) return <SignInScreen />;
    return (
      <div
        className="mx-auto max-w-md py-16 text-center text-sm text-blocked"
        data-testid="auth-error"
        role="alert"
      >
        {t("auth.error.loadSession", { message: error.message })}
      </div>
    );
  }

  if (!me) return <AuthLoading />;

  if (me.onboarding_step === "install") return <InstallGate me={me} />;
  if (me.onboarding_step === "consent") return <ConsentGate me={me} />;

  return <AuthProvider me={me}>{children}</AuthProvider>;
}
