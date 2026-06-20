import { describe, expect, it } from "vitest";
import { footerHTML, topbarHTML } from "./public-shell.js";

describe("public-shell", () => {
  it("renders shared topbar with locale flags and guest actions", () => {
    const html = topbarHTML("minimal");
    expect(html).toContain("locale-flag");
    expect(html).toContain("nav-sign-in");
    expect(html).toContain("user-menu-wrap");
    expect(html).not.toContain("site-nav-links");
  });

  it("renders marketing nav links in full variant", () => {
    const html = topbarHTML("full");
    expect(html).toContain("site-nav-links");
    expect(html).toContain('href="/#features"');
  });

  it("marks active legal footer link", () => {
    const html = footerHTML("privacy");
    expect(html).toContain('href="/politique-confidentialite"');
    expect(html).toMatch(/politique-confidentialite[^>]*aria-current="page"/);
  });
});
