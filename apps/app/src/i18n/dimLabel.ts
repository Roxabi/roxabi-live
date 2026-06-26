import type { TFunc } from "@/i18n";
import { type Dim, dimDisplayLabel, isEmptyDimValue } from "@roxabi-live/shared";

// Dims whose empty "(None)" bucket has a localized label (dim.empty.*). Other
// dims' values are pure data (milestone names, P1, repo names, …) and never
// translate — for those we keep the shared display label as-is.
const TRANSLATED_EMPTY = new Set<Dim>(["milestone", "priority", "lane", "size", "assignee"]);

/**
 * Localized group/band label for a dimension value. The empty bucket of a
 * known dim is translated via the i18n catalog; everything else falls back to
 * `fallback` (when the caller already computed a specially-formatted label,
 * e.g. the repo column header) or to the shared `dimDisplayLabel`.
 *
 * This is the app-side bridge for `packages/shared` dimDisplayLabel, which is a
 * pure-logic package with no React/locale context of its own.
 */
export function localizedDimLabel(t: TFunc, code: string, dim: Dim, fallback?: string): string {
  if (TRANSLATED_EMPTY.has(dim) && isEmptyDimValue(code, dim)) return t(`dim.empty.${dim}`);
  return fallback ?? dimDisplayLabel(code, dim);
}
