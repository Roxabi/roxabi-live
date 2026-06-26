import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "@/i18n";
import { ZkNotices } from "./ZkNotices";

// Render inside a forced-French provider so the assertions below match the FR
// catalog copy (the components now resolve strings through useT()).
const html = (props: {
  needsGithubLink: boolean;
  migrationIncomplete: boolean;
  zkActive?: boolean;
  allowGithubLink?: boolean;
  githubLogin?: string;
}) =>
  renderToStaticMarkup(
    createElement(LocaleProvider, {
      initialLocale: "fr",
      children: createElement(ZkNotices, props),
    }),
  );

describe("ZkNotices", () => {
  it("shows the dismissable encryption-info banner when ZK is active", () => {
    const out = html({ needsGithubLink: false, migrationIncomplete: false, zkActive: true });
    expect(out).toContain("jamais accessibles en clair sur le");
    expect(out).toContain("pas récupérable");
    expect(out).toContain("générer une nouvelle");
    expect(out).toContain('data-testid="zk-info-dismiss"');
  });

  it("renders nothing when no notice is active", () => {
    expect(html({ needsGithubLink: false, migrationIncomplete: false, zkActive: false })).toBe("");
  });

  it("still surfaces the GitHub-link fallback when titles cannot be sealed", () => {
    const out = html({ needsGithubLink: true, migrationIncomplete: false, zkActive: false });
    expect(out).toContain("Lier GitHub");
    expect(out).toContain('data-testid="zk-github-link-notice"');
  });

  it("does not show the info banner when ZK is inactive even if a fallback is shown", () => {
    const out = html({ needsGithubLink: true, migrationIncomplete: false, zkActive: false });
    expect(out).not.toContain('data-testid="zk-info-notice"');
  });

  it("suppresses the GitHub-link prompt for active ZK users (auto-handoff replaces it)", () => {
    const out = html({ needsGithubLink: true, migrationIncomplete: false, zkActive: true });
    // The reassuring info banner shows; the scary manual-link prompt does not.
    expect(out).toContain('data-testid="zk-info-notice"');
    expect(out).not.toContain('data-testid="zk-github-link-notice"');
    expect(out).not.toContain("Lier GitHub");
  });

  it("re-surfaces the GitHub-link prompt for active users once the silent bounce is exhausted", () => {
    const out = html({
      needsGithubLink: true,
      migrationIncomplete: false,
      zkActive: true,
      allowGithubLink: true,
    });
    // Silent handoff failed to yield a token → fall back to the manual prompt
    // (alongside the info banner) so the user is never stuck without a path.
    expect(out).toContain('data-testid="zk-info-notice"');
    expect(out).toContain('data-testid="zk-github-link-notice"');
    expect(out).toContain("Lier GitHub");
  });
});
