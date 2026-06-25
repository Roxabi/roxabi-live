import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZkNotices } from "./ZkNotices";

const html = (props: {
  needsGithubLink: boolean;
  migrationIncomplete: boolean;
  zkActive?: boolean;
  githubLogin?: string;
}) => renderToStaticMarkup(createElement(ZkNotices, props));

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
});
