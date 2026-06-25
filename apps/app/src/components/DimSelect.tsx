import type { Dim } from "@roxabi-live/shared";

const DIMS: { value: Dim; label: string }[] = [
  { value: "none", label: "None" },
  { value: "milestone", label: "Milestone" },
  { value: "priority", label: "Priority" },
  { value: "repo", label: "Repo" },
  { value: "lane", label: "Lane" },
  { value: "size", label: "Size" },
  { value: "status", label: "Status" },
  { value: "parent", label: "Parent" },
  { value: "assignee", label: "Assignee" },
];

interface DimSelectProps {
  label: string;
  value: Dim;
  onChange: (value: Dim) => void;
  allowNone?: boolean;
}

/** A small labelled dimension picker (pivot rows/cols/group). */
export function DimSelect({ label, value, onChange, allowNone = true }: DimSelectProps) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Dim)}
        className="rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground focus:border-primary/60 focus:outline-none"
      >
        {DIMS.filter((d) => allowNone || d.value !== "none").map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );
}
