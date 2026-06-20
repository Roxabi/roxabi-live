import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectLocale, normalizeLocale, setLocale, t } from "./i18n.js";

describe("i18n", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("location", { ...window.location, search: "", href: "http://localhost/" });
  });

  it("normalizes locale codes", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr")).toBe("fr");
    expect(normalizeLocale("fr-FR")).toBe("fr");
    expect(normalizeLocale("de")).toBe("fr");
  });

  it("returns French and English strings", () => {
    expect(t("fr", "nav.signIn")).toBe("Se connecter");
    expect(t("en", "nav.signIn")).toBe("Sign in");
  });

  it("persists locale choice", () => {
    setLocale("en");
    expect(localStorage.getItem("roxabi:locale")).toBe("en");
  });

  it("reads locale from URL param", () => {
    vi.stubGlobal("location", {
      ...window.location,
      search: "?lang=en",
      href: "http://localhost/?lang=en",
    });
    expect(detectLocale()).toBe("en");
  });
});
