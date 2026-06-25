/**
 * AuthContext — exposes the authenticated, fully-onboarded MePayload to the app
 * chrome (header, user menu, org picker, settings). Only ever provided once the
 * AuthGate has resolved onboarding_step === "ready", so consumers can treat
 * `me` as non-null.
 */

import type { MePayload } from "@roxabi-live/shared";
import { createContext, useContext } from "react";

const AuthContext = createContext<MePayload | null>(null);

export function AuthProvider({ me, children }: { me: MePayload; children: React.ReactNode }) {
  return <AuthContext.Provider value={me}>{children}</AuthContext.Provider>;
}

export function useAuth(): MePayload {
  const me = useContext(AuthContext);
  if (!me) throw new Error("useAuth must be used within an AuthProvider (ready state only)");
  return me;
}
