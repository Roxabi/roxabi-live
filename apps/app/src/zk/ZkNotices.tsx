/**
 * ZkNotices — dashboard banners for the ZK (zero-knowledge) encryption mode.
 *
 *  1. Info (dismissable): reassures that issue titles/content are encrypted
 *     server-side and that the passphrase is unrecoverable.
 *  2. GitHub link (fallback): titles stayed "(sealed)" because no GitHub user
 *     token is available to import + encrypt them. Rare now — the server
 *     auto-hands-off the token on every login of an enrolled user, and the first
 *     enrolment kicks off the handoff itself — so this only shows if that failed.
 *  3. Migration: a v1→v2 migration left undecryptable rows behind.
 */

import { GithubLogo, Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { useT } from "@/i18n";
import { zkLoginUrl } from "./github";

// Per-user so a shared browser doesn't suppress the notice for another account
// (matches the githubLogin-scoping of the ZK device/remember keys).
function infoDismissKey(githubLogin: string): string {
  return `rl:zk-info-dismissed:${githubLogin}`;
}

function readInfoDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function ZkNotices({
  needsGithubLink,
  migrationIncomplete,
  zkActive = false,
  githubLogin = "",
}: {
  needsGithubLink: boolean;
  migrationIncomplete: boolean;
  zkActive?: boolean;
  githubLogin?: string;
}) {
  const t = useT();
  const dismissKey = infoDismissKey(githubLogin);
  const [infoDismissed, setInfoDismissed] = useState(() => readInfoDismissed(dismissKey));
  const showInfo = zkActive && !infoDismissed;
  // The manual "link GitHub" prompt is a pre-auto-handoff relic: an active ZK
  // user gets their token handed off on every login, so never surface it to
  // them — the reassuring info banner is the replacement.
  const showGithubLink = needsGithubLink && !zkActive;

  if (!showInfo && !showGithubLink && !migrationIncomplete) return null;

  return (
    <div className="space-y-2">
      {showInfo && (
        <div
          data-testid="zk-info-notice"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground"
        >
          <span aria-hidden className="shrink-0 text-primary">
            🔒
          </span>
          <span className="min-w-0">
            {t("zk.notice.info.body")}
          </span>
          <button
            type="button"
            data-testid="zk-info-dismiss"
            aria-label={t("zk.notice.info.dismiss")}
            onClick={() => {
              try {
                localStorage.setItem(dismissKey, "1");
              } catch {
                /* ignore disabled storage */
              }
              setInfoDismissed(true);
            }}
            className="ml-auto shrink-0 rounded px-1.5 text-lg leading-none text-muted-foreground transition-colors hover:text-foreground"
          >
            ×
          </button>
        </div>
      )}
      {showGithubLink && (
        <div
          data-testid="zk-github-link-notice"
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground"
        >
          <GithubLogo className="size-4 shrink-0" aria-hidden />
          <span>
            {t("zk.notice.githubLink.body")}
          </span>
          <a
            href={zkLoginUrl()}
            className="ml-auto font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("zk.notice.githubLink.cta")}
          </a>
        </div>
      )}
      {migrationIncomplete && (
        <div
          data-testid="zk-migration-notice"
          className="flex flex-wrap items-center gap-2 rounded-md border border-blocked/30 bg-blocked/10 px-3 py-2 text-sm text-foreground"
        >
          <Warning className="size-4 shrink-0" aria-hidden />
          <span>
            {t("zk.notice.migration.body")}
          </span>
        </div>
      )}
    </div>
  );
}
