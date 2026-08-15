export interface FilterChip {
  key: string;
  label: string;      // e.g. "Segment is Investor"
  onRemove: () => void;
}

// Twenty-style active-filter chips: each applied filter renders as a dismissible
// pill above the table, with one "Clear all" when more than one is active.
// Token-driven (dark console), no one-off Tailwind colors.
export default function FilterChips({
  chips,
  onClearAll,
}: {
  chips: FilterChip[];
  onClearAll?: () => void;
}) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] py-1 pl-3 pr-1.5 text-xs font-medium text-[var(--text-primary)]"
        >
          {c.label}
          <button
            type="button"
            onClick={c.onRemove}
            aria-label={`Remove filter ${c.label}`}
            className="flex size-4 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </span>
      ))}
      {chips.length > 1 && onClearAll && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-medium text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
