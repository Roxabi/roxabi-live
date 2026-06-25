import { SingleSelect } from "@/components/SingleSelect";
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

/** A small labelled dimension picker (pivot rows/cols/group) — themed dropdown. */
export function DimSelect({ label, value, onChange, allowNone = true }: DimSelectProps) {
  const options = DIMS.filter((d) => allowNone || d.value !== "none");
  return (
    <SingleSelect
      label={label}
      value={value}
      options={options}
      onChange={(v) => onChange(v as Dim)}
    />
  );
}
