/**
 * ZkNotices — dashboard banners ported from frontend/app.js showZkGithubLinkNotice
 * / showZkMigrationNotice. Surfaces two sealing side-effects the gate cannot fix
 * silently: (1) titles stayed "(sealed)" because no GitHub user token is linked
 * to pull issue content; (2) a v1→v2 migration left undecryptable rows behind.
 */

import { GithubLogo, Warning } from "@phosphor-icons/react";
import { zkLoginUrl } from "./github";

export function ZkNotices({
  needsGithubLink,
  migrationIncomplete,
}: {
  needsGithubLink: boolean;
  migrationIncomplete: boolean;
}) {
  if (!needsGithubLink && !migrationIncomplete) return null;

  return (
    <div className="space-y-2">
      {needsGithubLink && (
        <div
          data-testid="zk-github-link-notice"
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground"
        >
          <GithubLogo className="size-4 shrink-0" aria-hidden />
          <span>
            Certains titres restent chiffrés sur le serveur. Liez GitHub pour importer et re-sceller
            leur contenu.
          </span>
          <a
            href={zkLoginUrl()}
            className="ml-auto font-medium text-primary underline-offset-4 hover:underline"
          >
            Lier GitHub
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
            Migration du chiffrement incomplète — certains anciens titres n'ont pas pu être
            convertis. Ouvrez Roxabi sur l'appareil d'origine pour la terminer.
          </span>
        </div>
      )}
    </div>
  );
}
