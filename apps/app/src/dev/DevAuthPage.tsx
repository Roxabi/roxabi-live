/**
 * DEV-only route (/dev/auth) for visually verifying the auth gates without a
 * live session. Switches between the install / consent / ready / sign-in
 * presentations using fixture MePayloads. Not in production builds.
 *
 * Note: this renders gate presentations directly. The AuthGate *orchestration*
 * (which onboarding_step → which gate) is verified separately by mocking
 * GET /api/me in the Playwright check.
 */

import { AuthProvider } from "@/auth/AuthContext";
import { ConsentGate } from "@/auth/ConsentGate";
import { InstallGate } from "@/auth/InstallGate";
import { OrgPicker } from "@/auth/OrgPicker";
import { SignInScreen } from "@/auth/SignInScreen";
import { UserMenu } from "@/auth/UserMenu";
import { useState } from "react";
import { fixtureMe } from "./authFixture";

type Scene = "signin" | "install" | "consent" | "ready" | "multiTenant";

const SCENES: Scene[] = ["signin", "install", "consent", "ready", "multiTenant"];

export default function DevAuthPage() {
  const [scene, setScene] = useState<Scene>("signin");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex flex-wrap gap-2 border-b border-border p-3" data-testid="scene-switcher">
        {SCENES.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`scene-${s}`}
            onClick={() => setScene(s)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              scene === s
                ? "border-primary bg-primary/15 text-primary"
                : "border-border text-muted-foreground hover:bg-card"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div data-testid="scene-stage">
        {scene === "signin" && <SignInScreen mode="signin" reason="session-lost" />}
        {scene === "install" && <InstallGate me={fixtureMe.install} />}
        {scene === "consent" && <ConsentGate me={fixtureMe.consent} />}
        {(scene === "ready" || scene === "multiTenant") && (
          <AuthProvider me={scene === "ready" ? fixtureMe.ready : fixtureMe.multiTenant}>
            <header className="flex items-center gap-3 border-b border-border px-6 py-3">
              <span className="text-lg font-semibold tracking-tight">Roxabi Live</span>
              <div className="ml-auto flex items-center gap-3">
                <OrgPicker me={scene === "ready" ? fixtureMe.ready : fixtureMe.multiTenant} />
                <UserMenu />
              </div>
            </header>
            <div className="p-6 text-sm text-muted-foreground">
              Authenticated chrome — open the avatar menu (top-right) → Settings.
            </div>
          </AuthProvider>
        )}
      </div>
    </div>
  );
}
