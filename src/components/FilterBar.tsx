interface FilterBarProps {
  segments: string[];
  selectedSegment: string;
  onSegmentChange: (segment: string) => void;
  counts?: Record<string, number>;
  total?: number;
}

// Unified with the app's design tokens — no per-segment rainbow. Every chip
// shares one neutral resting style; the selected chip gets the single brand
// accent (the same blue the rest of the app uses for selection/links). Keeps
// the segment bar legible in light and dark without competing colors.
export default function FilterBar({ segments, selectedSegment, onSegmentChange, counts, total }: FilterBarProps) {
  const chip = (seg: string, label: string, active: boolean, count?: number) => (
    <button
      key={seg || 'all'}
      onClick={() => onSegmentChange(seg)}
      className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium capitalize transition ${
        active
          ? 'border-[var(--brand)] bg-[var(--brand)] text-white shadow-sm'
          : 'border-[var(--border-strong)] bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {label}
      {typeof count === 'number' && (
        <span
          className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
            active ? 'bg-white/25 text-white' : 'bg-[var(--bg-surface)] text-[var(--text-secondary)]'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex flex-wrap gap-2">
      {chip('', 'All segments', !selectedSegment, total)}
      {segments.map((seg) => chip(seg, seg, selectedSegment === seg, counts?.[seg]))}
    </div>
  );
}
