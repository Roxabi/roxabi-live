import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "@/i18n";
import { TitleSyncBanner } from "./TitleSyncBanner";

// Forced-French provider so assertions match the FR catalog copy.
const html = (props: { syncing: boolean; count: number }) =>
  renderToStaticMarkup(
    createElement(LocaleProvider, {
      initialLocale: "fr",
      children: createElement(TitleSyncBanner, props),
    }),
  );

describe("TitleSyncBanner", () => {
  it("renders nothing when not syncing", () => {
    expect(html({ syncing: false, count: 5 })).toBe("");
  });

  it("shows the spinner banner + count while titles import", () => {
    const out = html({ syncing: true, count: 12 });
    expect(out).toContain('data-testid="title-sync-banner"');
    expect(out).toContain("Importation des titres");
    expect(out).toContain("12 à déchiffrer");
  });

  it("omits the detail count when there is none", () => {
    const out = html({ syncing: true, count: 0 });
    expect(out).toContain('data-testid="title-sync-banner"');
    expect(out).not.toContain("à déchiffrer");
  });
});
