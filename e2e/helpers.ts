import type { APIRequestContext, Page } from "@playwright/test";

export const E2E_LOGIN = "e2e-delete-user";

export interface SeedResult {
  user_id: number;
  session_token: string;
}

export interface SeedOptions {
  zk_backup?: boolean;
  consent?: boolean;
  github_login?: string;
}

function seedBody(opts: SeedOptions = {}) {
  return {
    github_login: opts.github_login ?? E2E_LOGIN,
    github_id: 88001,
    consent: opts.consent ?? true,
    zk_backup: opts.zk_backup ?? false,
  };
}

export async function seedSession(
  request: APIRequestContext,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const res = await request.post("/__test__/seed", { data: seedBody(opts) });
  if (!res.ok()) {
    throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
  }
  return res.json() as Promise<SeedResult>;
}

/** Seed via the page's request context so Set-Cookie is visible to navigation. */
export async function seedSessionInPage(page: Page, opts: SeedOptions = {}): Promise<SeedResult> {
  const res = await page.request.post("/__test__/seed", { data: seedBody(opts) });
  if (!res.ok()) {
    throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
  }
  return res.json() as Promise<SeedResult>;
}

export async function mintReauthProof(
  request: APIRequestContext,
  userId: number,
): Promise<string> {
  const res = await request.post("/__test__/reauth-proof", { data: { user_id: userId } });
  if (!res.ok()) throw new Error(`reauth proof failed: ${res.status()}`);
  const body = (await res.json()) as { reauth_proof: string };
  return body.reauth_proof;
}

export async function userState(request: APIRequestContext, login = E2E_LOGIN) {
  const res = await request.get(`/__test__/user-state?github_login=${encodeURIComponent(login)}`);
  return res.json() as Promise<{
    exists: boolean;
    zk_enrolled?: boolean;
    consent_at?: string | null;
    installations?: number;
    sessions?: number;
  }>;
}

/** @deprecated use seedSessionInPage — manual cookies miss HttpOnly/Secure from Set-Cookie */
export async function setSessionCookie(page: Page, token: string) {
  await page.context().addCookies([
    {
      name: "roxabi_session",
      value: token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}