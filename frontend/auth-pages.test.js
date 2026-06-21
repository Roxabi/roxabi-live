import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("auth-pages", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("location", { replace: vi.fn(), search: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to dashboard when /api/me returns a user", async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ user: { github_login: "octocat" } }),
    });

    const { initAuthPage } = await import("./auth-pages.js");
    await initAuthPage("signin");

    expect(location.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("appends remember=1 to OAuth URL when checkbox is checked", async () => {
    fetch.mockResolvedValue({ ok: false });
    document.body.innerHTML = `
      <div id="public-topbar-mount"></div>
      <div id="public-footer-mount"></div>
      <input type="checkbox" id="auth-remember" checked />
      <a id="auth-github-btn" href="#"></a>
    `;

    const { initAuthPage } = await import("./auth-pages.js");
    await initAuthPage("signin");

    const href = document.getElementById("auth-github-btn")?.getAttribute("href") ?? "";
    expect(href).toContain("remember=1");
  });

  it("renders the auth page for guests", async () => {
    fetch.mockResolvedValue({ ok: false });

    document.body.innerHTML =
      '<div id="public-topbar-mount"></div><div id="public-footer-mount"></div>';

    const { initAuthPage } = await import("./auth-pages.js");
    await initAuthPage("signup");

    expect(location.replace).not.toHaveBeenCalled();
    expect(document.getElementById("public-topbar-mount")?.innerHTML).toContain("site-topbar");
  });
});
