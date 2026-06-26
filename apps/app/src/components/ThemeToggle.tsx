import { useT } from "@/i18n";
import { type Theme, applyTheme, readTheme } from "@/lib/theme";
import { Moon, Sun } from "@phosphor-icons/react";
import { useState } from "react";

/** Dark/light theme toggle — legacy header `.theme-btn` (🌙). */
export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const next: Theme = theme === "dark" ? "light" : "dark";
  const nextLabel = next === "dark" ? t("settings.theme.dark") : t("settings.theme.light");

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      title={t("settings.theme.switchTo", { next: nextLabel })}
      aria-label={t("settings.theme.switchTo", { next: nextLabel })}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
    >
      {theme === "dark" ? (
        <Moon size={16} weight="fill" aria-hidden />
      ) : (
        <Sun size={16} weight="fill" aria-hidden />
      )}
    </button>
  );
}
