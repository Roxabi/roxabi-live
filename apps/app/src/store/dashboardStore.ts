/**
 * dashboardStore — all cockpit view + filter state (zustand).
 *
 * Persistence mirrors the vanilla split (frontend/state.js):
 *   - per-tab filter/view state  → sessionStorage (each tab filters independently)
 *   - graphCol ("order by")      → localStorage  (a cross-tab preference)
 *
 * This is a fresh origin (app.live.roxabi.dev), so storage keys are clean (`rl:`
 * prefix) — no migration from the old v6:/v7: keys is needed.
 */

import type { Dim, StatusKey } from "@roxabi-live/shared";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type { Dim };
export type ViewKey = "list" | "pivot" | "graph";

/** Multi-select filter facets. */
export interface FilterFacets {
  repo: string[];
  milestone: string[];
  priority: string[];
  assignee: string[];
  status: StatusKey[];
  label: string[];
}

export type FacetKey = keyof FilterFacets;

const GRAPH_COL_KEY = "rl:graphCol"; // localStorage (cross-tab)

function readGraphCol(): Dim {
  try {
    return (localStorage.getItem(GRAPH_COL_KEY) as Dim | null) ?? "none";
  } catch {
    return "none";
  }
}

interface DashboardState extends FilterFacets {
  view: ViewKey;
  search: string;
  showParents: boolean;
  showClosedUnderOpenEpic: boolean;
  showAssignees: boolean;
  listGroup: Dim;
  listGroup2: Dim;
  tableGroup: Dim;
  pivotRow: Dim;
  pivotCol: Dim;
  graphRow: Dim;
  graphCol: Dim;
  // actions
  patch: (partial: Partial<DashboardState>) => void;
  toggleFacet: (facet: FacetKey, value: string) => void;
  clearFacet: (facet: FacetKey) => void;
  resetFilters: () => void;
}

const DEFAULT_FACETS: FilterFacets = {
  repo: [],
  milestone: [],
  priority: [],
  assignee: [],
  status: ["ready", "running", "blocked"],
  label: [],
};

const DEFAULTS = {
  ...DEFAULT_FACETS,
  view: "list" as ViewKey,
  search: "",
  showParents: false,
  showClosedUnderOpenEpic: false,
  showAssignees: false,
  listGroup: "none" as Dim,
  listGroup2: "none" as Dim,
  tableGroup: "none" as Dim,
  pivotRow: "milestone" as Dim,
  pivotCol: "priority" as Dim,
  graphRow: "milestone" as Dim,
};

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      graphCol: readGraphCol(),
      patch: (partial) => {
        if ("graphCol" in partial && partial.graphCol) {
          try {
            localStorage.setItem(GRAPH_COL_KEY, partial.graphCol);
          } catch {
            // ignore quota / disabled storage
          }
        }
        set(partial);
      },
      toggleFacet: (facet, value) => {
        const current = get()[facet] as string[];
        const next = current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value];
        set({ [facet]: next } as Partial<DashboardState>);
      },
      clearFacet: (facet) => set({ [facet]: [] } as Partial<DashboardState>),
      // Reset clears every filter: facets, search, and the Epics (showParents)
      // toggle. View prefs (grouping dims, graphCol) are intentionally untouched.
      resetFilters: () => set({ ...DEFAULT_FACETS, search: "", showParents: false }),
    }),
    {
      name: "rl:dashboard",
      storage: createJSONStorage(() => sessionStorage),
      // graphCol lives in localStorage (cross-tab); actions are never persisted.
      partialize: ({ patch, toggleFacet, clearFacet, resetFilters, graphCol, ...rest }) => rest,
    },
  ),
);
