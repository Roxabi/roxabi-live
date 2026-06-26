import { FilterMultiSelect } from "@/components/FilterMultiSelect";
import { useFilterOptions } from "@/hooks/useFilterOptions";
import { useT } from "@/i18n";
import { type FacetKey, useDashboardStore } from "@/store/dashboardStore";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { AnnotatedNode } from "@roxabi-live/shared";

/** The cockpit filter row: search + per-facet multi-selects + reset. */
export function FilterBar({ nodes }: { nodes: AnnotatedNode[] }) {
  const t = useT();
  const options = useFilterOptions(nodes);

  const FACETS: { key: FacetKey; label: string }[] = [
    { key: "status", label: t("filter.facet.status") },
    { key: "repo", label: t("filter.facet.repo") },
    { key: "milestone", label: t("filter.facet.milestone") },
    { key: "priority", label: t("filter.facet.priority") },
    { key: "label", label: t("filter.facet.label") },
    { key: "assignee", label: t("filter.facet.assignee") },
  ];

  const status = useDashboardStore((s) => s.status);
  const repo = useDashboardStore((s) => s.repo);
  const milestone = useDashboardStore((s) => s.milestone);
  const priority = useDashboardStore((s) => s.priority);
  const label = useDashboardStore((s) => s.label);
  const assignee = useDashboardStore((s) => s.assignee);
  const search = useDashboardStore((s) => s.search);

  const patch = useDashboardStore((s) => s.patch);
  const toggleFacet = useDashboardStore((s) => s.toggleFacet);
  const clearFacet = useDashboardStore((s) => s.clearFacet);
  const resetFilters = useDashboardStore((s) => s.resetFilters);

  const selectedByFacet: Record<FacetKey, string[]> = {
    status,
    repo,
    milestone,
    priority,
    label,
    assignee,
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <MagnifyingGlass
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(e) => patch({ search: e.target.value })}
          placeholder={t("filter.search.placeholder")}
          aria-label={t("filter.search.ariaLabel")}
          className="h-8 w-52 rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none"
        />
      </div>

      {FACETS.map(({ key, label: facetLabel }) => (
        <FilterMultiSelect
          key={key}
          label={facetLabel}
          options={options[key]}
          selected={selectedByFacet[key]}
          onToggle={(value) => toggleFacet(key, value)}
          onClear={() => clearFacet(key)}
        />
      ))}

      <button
        type="button"
        data-testid="facet-reset"
        onClick={resetFilters}
        className="ml-auto inline-flex h-8 items-center rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {t("filter.reset.label")}
      </button>
    </div>
  );
}
