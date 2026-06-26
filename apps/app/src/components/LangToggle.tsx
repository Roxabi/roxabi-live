import { useLocale } from "@/i18n";

/** FR/EN language toggle — header control. Shows the language it switches TO
 * (matches the marketing site's langSwitch convention). Sized to match the
 * theme toggle / avatar (size-9) so the header controls stay aligned. */
export function LangToggle() {
  const { locale, setLocale } = useLocale();
  const next = locale === "fr" ? "en" : "fr";

  return (
    <button
      type="button"
      data-testid="lang-toggle"
      title={`Switch to ${next.toUpperCase()}`}
      aria-label={`Switch language to ${next.toUpperCase()}`}
      onClick={() => setLocale(next)}
      className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-card font-mono text-[11px] font-bold tracking-wide text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
    >
      {next.toUpperCase()}
    </button>
  );
}
