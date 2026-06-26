import { SingleSelect } from "@/components/SingleSelect";
import { useT } from "@/i18n";
import type { Dim } from "@roxabi-live/shared";

const DIM_VALUES: Dim[] = [
  "none",
  "milestone",
  "priority",
  "repo",
  "lane",
  "size",
  "status",
  "parent",
  "assignee",
];

interface DimSelectProps {
  label: string;
  value: Dim;
  onChange: (value: Dim) => void;
  allowNone?: boolean;
}

/** A small labelled dimension picker (pivot rows/cols/group) — themed dropdown. */
export function DimSelect({ label, value, onChange, allowNone = true }: DimSelectProps) {
  const t = useT();
  const options = DIM_VALUES.filter((d) => allowNone || d !== "none").map((d) => ({
    value: d,
    label: t(`dim.option.${d}`),
  }));
  return (
    <SingleSelect
      label={label}
      value={value}
      options={options}
      onChange={(v) => onChange(v as Dim)}
    />
  );
}
