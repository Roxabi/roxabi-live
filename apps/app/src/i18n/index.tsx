/**
 * i18n — FR/EN locale management for the cockpit (apps/app).
 *
 * Mirrors the marketing site's catalog shape (`fr` is the typed source of
 * truth, `en` conforms to `typeof fr`) but adds a React runtime: a context
 * provider holds the active locale, `useT()` returns a `t(key, vars)` resolver
 * that walks the nested catalog by dot-path and interpolates `{vars}`. The
 * choice persists to localStorage (`roxabi:locale`, same key as the legacy
 * public pages) and drives `<html lang>`.
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en } from "./en";
import { fr } from "./fr";

export type Locale = "fr" | "en";

const CATALOG: Record<Locale, unknown> = { fr, en };
const STORAGE_KEY = "roxabi:locale";

/** Stored choice → browser language (fr* → fr) → en. */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "fr" || stored === "en") return stored;
  } catch {
    /* storage disabled */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* storage disabled */
  }
}

/** Walk a nested catalog object by "a.b.c" and return the leaf string. */
function resolve(catalog: unknown, key: string): string | undefined {
  let cur: unknown = catalog;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunc;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  /** Force the starting locale (tests / SSR); defaults to runtime detection. */
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    persistLocale(next);
    setLocaleState(next);
  }, []);

  const t = useCallback<TFunc>(
    (key, vars) => {
      // active locale → en → fr fallback chain, then the raw key as last resort.
      const hit = resolve(CATALOG[locale], key) ?? resolve(en, key) ?? resolve(fr, key);
      return interpolate(hit ?? key, vars);
    },
    [locale],
  );

  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within a LocaleProvider");
  return ctx;
}

/** Convenience hook for components that only need the translator. */
export function useT(): TFunc {
  return useLocale().t;
}
