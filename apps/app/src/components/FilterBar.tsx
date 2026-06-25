import { FilterMultiSelect } from "@/components/FilterMultiSelect";
import { useFilterOptions } from "@/hooks/useFilterOptions";
import { cn } from "@/lib/utils";
import { type FacetKey, useDashboardStore } from "@/store/dashboardStore";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { AnnotatedNode } from "@roxabi-live/shared";

const FACETS: { key: FacetKey; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "repo", label: "Repo" },
  { key: "milestone", label: "Milestone" },
  { key: "priority", label: "Priority" },
  { key: "label", label: "Label" },
  { key: "assignee", label: "Assignee" },
];

/** The cockpit filter row: search + per-facet multi-selects + parent toggle. */
export function FilterBar({ nodes }: { nodes: AnnotatedNode[] }) {
  const options = useFilterOptions(nodes);

  const status = useDashboardStore((s) => s.status);
  const repo = useDashboardStore((s) => s.repo);
  const milestone = useDashboardStore((s) => s.milestone);
  const priority = useDashboardStore((s) => s.priority);
  const label = useDashboardStore((s) => s.label);
  const assignee = useDashboardStore((s) => s.assignee);
  const search = useDashboardStore((s) => s.search);
  const showParents = useDashboardStore((s) => s.showParents);

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
          placeholder="Search issues…"
          aria-label="Search issues"
          className="h-7 w-52 rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none"
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
        data-testid="facet-epics"
        onClick={() => patch({ showParents: !showParents })}
        aria-pressed={showParents}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors hover:border-primary/60",
          showParents ? "border-primary/50 text-foreground" : "border-border text-muted-foreground",
        )}
      >
        Epics
      </button>

      <button
        type="button"
        data-testid="facet-reset"
        onClick={resetFilters}
        className="ml-auto rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        Reset
      </button>
    </div>
  );
}
