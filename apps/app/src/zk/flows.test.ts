// @vitest-environment jsdom
// Port-fidelity unit tests for the slice-10 ZK flow state machines that don't
// need WebCrypto/IndexedDB (those are browser-verified via the gate E2E). Covers
// github token/reauth/handoff URL handling, the reset pending/recovery guard,
// settings reauth resume parsing, and the v1-envelope detector.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, apiFetch: apiFetchMock };
});

import { ApiError } from "@/lib/api";
import { payloadsHaveV1 } from "./enroll";
import {
  clearZkReauthProof,
  consumeZkHandoffFromUrl,
  consumeZkReauthFromUrl,
  getGithubUserToken,
  getZkReauthProof,
  hasAttemptedHandoffRefresh,
  refreshGithubTokenViaHandoff,
  setGithubUserToken,
  zkLoginUrl,
  zkReauthLoginUrl,
} from "./github";
import {
  ZkResetError,
  clearZkResetPending,
  isZkResetPending,
  reconcileZkResetPendingAfterReauth,
  resetZkAccountAndReenroll,
  setZkResetPending,
} from "./reset";
import { consumeSettingsResume } from "./settingsReauth";

function setUrl(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}

beforeEach(() => {
  apiFetchMock.mockReset();
  sessionStorage.clear();
  localStorage.clear();
  setUrl("");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("github token + reauth", () => {
  it("round-trips the github user token in sessionStorage", () => {
    expect(getGithubUserToken()).toBeNull();
    setGithubUserToken("ghu_abc");
    expect(getGithubUserToken()).toBe("ghu_abc");
    setGithubUserToken(null);
    expect(getGithubUserToken()).toBeNull();
  });

  it("builds zk login + reauth URLs with encoded redirects", () => {
    expect(zkLoginUrl("/x?y=1")).toBe("/login?zk=1&redirect=%2Fx%3Fy%3D1");
    expect(zkReauthLoginUrl("/x")).toBe("/login?reauth=1&redirect=%2Fx");
  });

  it("consumes ?zk_reauth= → proof in sessionStorage + strips the param", async () => {
    setUrl("?zk_reauth=code123&keep=1");
    apiFetchMock.mockResolvedValueOnce({ reauth_proof: "proof-xyz" });
    const ok = await consumeZkReauthFromUrl();
    expect(ok).toBe(true);
    expect(getZkReauthProof()).toBe("proof-xyz");
    expect(window.location.search).toBe("?keep=1");
    clearZkReauthProof();
    expect(getZkReauthProof()).toBeNull();
  });

  it("returns false (no proof) when consume-reauth has no code", async () => {
    setUrl("?other=1");
    expect(await consumeZkReauthFromUrl()).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("swallows a consume-reauth API failure", async () => {
    setUrl("?zk_reauth=bad");
    apiFetchMock.mockRejectedValueOnce(new ApiError(400, "nope"));
    expect(await consumeZkReauthFromUrl()).toBe(false);
    expect(getZkReauthProof()).toBeNull();
  });

  it("consumes ?zk_handoff= → github token + strips the param", async () => {
    setUrl("?zk_handoff=hc");
    apiFetchMock.mockResolvedValueOnce({ github_token: "ghu_handoff" });
    expect(await consumeZkHandoffFromUrl()).toBe(true);
    expect(getGithubUserToken()).toBe("ghu_handoff");
    expect(window.location.search).toBe("");
  });
});

describe("silent handoff refresh (self-heal stale sessions)", () => {
  // jsdom makes location.assign non-configurable, so vi.spyOn can't wrap it.
  // Stub the whole window.location (the window property IS configurable) with a
  // plain object carrying the path pieces the helper reads + a mock assign().
  const realLocation = window.location;
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/", search: "?foo=1", hash: "", assign: assignSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: realLocation,
    });
  });

  it("bounces through the OAuth handoff once when no token is present", () => {
    expect(hasAttemptedHandoffRefresh("octocat")).toBe(false);

    expect(refreshGithubTokenViaHandoff("octocat")).toBe(true);
    expect(hasAttemptedHandoffRefresh("octocat")).toBe(true);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(zkLoginUrl("/?foo=1"));

    // Loop guard: a bounce that returned no token must not re-trigger.
    expect(refreshGithubTokenViaHandoff("octocat")).toBe(false);
    expect(assignSpy).toHaveBeenCalledTimes(1);
  });

  it("never bounces when a github token already exists", () => {
    setGithubUserToken("ghu_present");
    expect(refreshGithubTokenViaHandoff("octocat")).toBe(false);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(hasAttemptedHandoffRefresh("octocat")).toBe(false);
  });

  it("scopes the attempt guard per github login", () => {
    expect(refreshGithubTokenViaHandoff("alice")).toBe(true);
    expect(hasAttemptedHandoffRefresh("alice")).toBe(true);
    expect(hasAttemptedHandoffRefresh("bob")).toBe(false);
  });
});

describe("reset pending + recovery guard", () => {
  it("tracks the reset-pending flag", () => {
    expect(isZkResetPending()).toBe(false);
    setZkResetPending();
    expect(isZkResetPending()).toBe(true);
    clearZkResetPending();
    expect(isZkResetPending()).toBe(false);
  });

  it("reconcile drops a pending reset with no proof", () => {
    setZkResetPending();
    reconcileZkResetPendingAfterReauth();
    expect(isZkResetPending()).toBe(false);
  });

  it("reconcile keeps a pending reset that has a proof", () => {
    setZkResetPending();
    sessionStorage.setItem("roxabi:zk-reauth-proof", "p");
    reconcileZkResetPendingAfterReauth();
    expect(isZkResetPending()).toBe(true);
  });

  it("reauth_required pre-guard never wipes (no recovery, rethrows)", async () => {
    // No proof present → postZkReset throws reauth_required BEFORE any network
    // call, so recoverFromPartialZkReset must not run (it would wipe local keys).
    await expect(resetZkAccountAndReenroll("octocat")).rejects.toMatchObject({
      code: "reauth_required",
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("maps a server reset error to ZkResetError.code", async () => {
    sessionStorage.setItem("roxabi:zk-reauth-proof", "p");
    // POST /api/zk/reset rejects rate_limited; /api/me (recovery probe) says still
    // enrolled → no wipe, rethrow with the code.
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/api/zk/reset")
        return Promise.reject(new ApiError(429, "rate_limited", { error: "rate_limited" }));
      if (path === "/api/me") return Promise.resolve({ user: { zk_enrolled: true } });
      return Promise.resolve({});
    });
    await expect(resetZkAccountAndReenroll("octocat")).rejects.toBeInstanceOf(ZkResetError);
    await expect(resetZkAccountAndReenroll("octocat")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("settings reauth resume", () => {
  it("returns nothing without a ?settings= param", () => {
    expect(consumeSettingsResume()).toEqual({
      openSettings: false,
      showPassphraseForm: false,
      runDelete: false,
    });
  });

  it("?settings=open just opens settings (no proof needed)", () => {
    setUrl("?settings=open");
    expect(consumeSettingsResume()).toEqual({
      openSettings: true,
      showPassphraseForm: false,
      runDelete: false,
    });
    expect(window.location.search).toBe("");
  });

  it("resumes passphrase form when action + proof present", () => {
    setUrl("?settings=passphrase");
    sessionStorage.setItem("roxabi:settings-pending-action", "passphrase");
    sessionStorage.setItem("roxabi:zk-reauth-proof", "proof");
    expect(consumeSettingsResume()).toEqual({
      openSettings: true,
      showPassphraseForm: true,
      runDelete: false,
    });
  });

  it("does not resume when the proof is missing", () => {
    setUrl("?settings=delete");
    sessionStorage.setItem("roxabi:settings-pending-action", "delete");
    expect(consumeSettingsResume().runDelete).toBe(false);
  });
});

describe("v1 envelope detection", () => {
  it("payloadsHaveV1 spots a v1 ECIES envelope", () => {
    expect(payloadsHaveV1([{ encrypted_payload: JSON.stringify({ v: 2 }) }])).toBe(false);
    expect(
      payloadsHaveV1([
        { encrypted_payload: JSON.stringify({ v: 2 }) },
        { encrypted_payload: JSON.stringify({ v: 1 }) },
      ]),
    ).toBe(true);
  });
});
