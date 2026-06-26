/**
 * BrandMark — Roxabi Live logo (amber tile + foundation-block glyph).
 * Inlined from brand/assets/logo-mark.svg so the header mark needs no extra
 * request and renders on the dark cockpit canvas.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 56 56"
      fill="none"
      className={className}
      role="img"
      aria-label="Roxabi Live"
    >
      <rect width="56" height="56" rx="12" fill="#f0b429" />
      <rect x="11" y="11" width="15.5" height="15.5" rx="3" fill="#0b0e14" opacity=".9" />
      <rect x="29.5" y="11" width="15.5" height="15.5" rx="3" fill="#0b0e14" opacity=".6" />
      <rect x="11" y="29.5" width="15.5" height="15.5" rx="3" fill="#0b0e14" opacity=".6" />
      <rect x="29.5" y="29.5" width="15.5" height="15.5" rx="3" fill="#0b0e14" opacity=".3" />
    </svg>
  );
}
