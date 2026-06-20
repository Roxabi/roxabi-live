import { expect, test } from "@playwright/test";
import {
  E2E_LOGIN,
  mintReauthProof,
  seedSession,
  seedSessionInPage,
  userState,
} from "./helpers";

test.describe("Delete my data & sign out", () => {
  test("API purge clears zk backup, consent, installs, and sessions", async ({ request }) => {
    const seed = await seedSession(request, { zk_backup: true, consent: true });

    const before = await userState(request);
    expect(before.zk_enrolled).toBe(true);
    expect(before.consent_at).not.toBeNull();
    expect(before.installations).toBe(1);
    expect(before.sessions).toBeGreaterThan(0);

    const proof = await mintReauthProof(request, seed.user_id);
    const del = await request.post("/api/account/delete", {
      headers: {
        Cookie: `roxabi_session=${seed.session_token}`,
        Origin: "http://127.0.0.1:8787",
      },
      data: { reauth_proof: proof },
    });
    expect(del.ok()).toBe(true);
    expect(del.headers()["set-cookie"] ?? "").toMatch(/Max-Age=0/i);

    const after = await userState(request);
    expect(after.zk_enrolled).toBe(false);
    expect(after.consent_at).toBeNull();
    expect(after.installations).toBe(0);
    expect(after.sessions).toBe(0);
  });

  test("GET /api/me returns 401 after account delete", async ({ request }) => {
    const seed = await seedSession(request, { zk_backup: false });
    const del = await request.post("/api/account/delete", {
      headers: {
        Cookie: `roxabi_session=${seed.session_token}`,
        Origin: "http://127.0.0.1:8787",
      },
      data: {},
    });
    expect(del.ok()).toBe(true);

    const me = await request.get("/api/me", {
      headers: { Cookie: `roxabi_session=${seed.session_token}` },
    });
    expect(me.status()).toBe(401);
  });

  test("dashboard loads for seeded ready session (no login redirect loop)", async ({ page }) => {
    await seedSessionInPage(page, { zk_backup: false, consent: true });
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page).not.toHaveURL(/\/login/);
    // ZK on + no backup → enroll gate; shell still served (footer visible).
    await expect(page.getByRole("navigation", { name: /Liens légaux/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("after zk purge, re-login shows enroll gate (not unlock)", async ({ page, request }) => {
    const seed = await seedSession(request, { zk_backup: true, consent: true });
    const proof = await mintReauthProof(request, seed.user_id);

    const del = await request.post("/api/account/delete", {
      headers: {
        Cookie: `roxabi_session=${seed.session_token}`,
        Origin: "http://127.0.0.1:8787",
      },
      data: { reauth_proof: proof },
    });
    expect(del.ok()).toBe(true);

    await seedSessionInPage(page, { zk_backup: false, consent: true });
    await page.goto("/dashboard");

    await expect(page.getByRole("heading", { name: /Set encryption passphrase/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: /Unlock encryption/i })).toBeHidden();
  });

  test("install-pending session auto-links on install refresh", async ({ request }) => {
    const seed = await seedSession(request, {
      install_pending: true,
      consent: true,
      zk_backup: false,
    });
    const linked = await request.post("/api/install/refresh", {
      headers: { Cookie: `roxabi_session=${seed.session_token}` },
    });
    expect(linked.ok()).toBe(true);
    const body = (await linked.json()) as { status: string; onboarding_step: string };
    expect(body.status).toBe("linked");
    expect(body.onboarding_step).toBe("ready");
  });

  test("zk enrolled delete without reauth_proof is rejected (no silent wipe)", async ({
    request,
  }) => {
    const seed = await seedSession(request, { zk_backup: true, consent: true });

    const del = await request.post("/api/account/delete", {
      headers: {
        Cookie: `roxabi_session=${seed.session_token}`,
        Origin: "http://127.0.0.1:8787",
        "Content-Type": "application/json",
      },
      data: {},
    });
    expect(del.status()).toBe(403);

    const state = await userState(request, E2E_LOGIN);
    expect(state.zk_enrolled).toBe(true);
  });
});