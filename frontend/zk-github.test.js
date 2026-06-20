import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();

vi.mock("./auth.js", () => ({
  api: (...args) => apiMock(...args),
}));

const { consumeZkReauthFromUrl, getZkReauthProof, clearZkReauthProof } = await import(
  "./zk-github.js"
);

describe("consumeZkReauthFromUrl", () => {
  beforeEach(() => {
    apiMock.mockReset();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("returns false when zk_reauth param is absent", async () => {
    const result = await consumeZkReauthFromUrl();
    expect(result).toBe(false);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("strips zk_reauth from URL and stores reauth_proof on success", async () => {
    window.history.replaceState({}, "", "/?zk_reauth=abc123&foo=bar");
    apiMock.mockResolvedValue({
      json: async () => ({ reauth_proof: "proof-token" }),
    });

    const result = await consumeZkReauthFromUrl();

    expect(result).toBe(true);
    expect(window.location.search).toBe("?foo=bar");
    expect(apiMock).toHaveBeenCalledWith(
      "/api/zk/consume-reauth",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "abc123" }),
      }),
    );
    expect(getZkReauthProof()).toBe("proof-token");
  });

  it("does not store proof when consume-reauth fails", async () => {
    window.history.replaceState({}, "", "/?zk_reauth=bad&foo=bar");
    apiMock.mockRejectedValue(new Error("/api/zk/consume-reauth 410"));

    const result = await consumeZkReauthFromUrl();

    expect(result).toBe(false);
    expect(getZkReauthProof()).toBeNull();
    expect(window.location.search).toBe("?zk_reauth=bad&foo=bar");
  });

  it("returns false when response omits reauth_proof", async () => {
    window.history.replaceState({}, "", "/?zk_reauth=abc");
    apiMock.mockResolvedValue({ json: async () => ({}) });

    const result = await consumeZkReauthFromUrl();

    expect(result).toBe(false);
    expect(getZkReauthProof()).toBeNull();
    expect(window.location.search).toBe("?zk_reauth=abc");
  });

  it("clearZkReauthProof removes stored proof", () => {
    sessionStorage.setItem("roxabi:zk-reauth-proof", "x");
    clearZkReauthProof();
    expect(getZkReauthProof()).toBeNull();
  });
});
