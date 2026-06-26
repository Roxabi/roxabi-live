import { CircleNotch } from "@phosphor-icons/react";
import { useT } from "@/i18n";

/**
 * Client-side title-import banner. While the ZK seal pass fetches issue
 * titles/bodies from GitHub and re-seals them (e.g. just after a token handoff
 * imports recently-synced issues), redacted titles render blank — this spinner
 * banner tells the user the import is in flight rather than stuck. Pure: the
 * `syncing`/`count` signal is computed in useDecryptedGraph.
 */
export function TitleSyncBanner({ syncing, count }: { syncing: boolean; count: number }) {
  const t = useT();
  if (!syncing) return null;

  return (
    <output
      aria-live="polite"
      data-testid="title-sync-banner"
      className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs"
    >
      <CircleNotch className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
      <strong className="text-foreground">{t("sync.titles.inProgress")}</strong>
      {count > 0 && (
        <span className="text-muted-foreground">{t("sync.titles.detail", { count })}</span>
      )}
    </output>
  );
}
