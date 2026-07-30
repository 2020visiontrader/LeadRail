interface FilterBarProps {
  segments: string[];
  selectedSegment: string;
  onSegmentChange: (segment: string) => void;
  counts?: Record<string, number>;
  total?: number;
}

// Per-segment palette. Literal class strings (Tailwind can't see dynamically
// built names). Inactive uses the theme-aware raised surface + colored text so
// every chip stays legible in both light and dark mode; active is a solid fill.
const PALETTE: Record<string, { active: string; idle: string }> = {
  investor: { active: 'bg-emerald-600 text-white border-emerald-600', idle: 'text-emerald-600 border-emerald-300 hover:border-emerald-500' },
  vc:       { active: 'bg-violet-600 text-white border-violet-600',   idle: 'text-violet-600 border-violet-300 hover:border-violet-500' },
  angel:    { active: 'bg-amber-500 text-white border-amber-500',     idle: 'text-amber-600 border-amber-300 hover:border-amber-500' },
  founder:  { active: 'bg-sky-600 text-white border-sky-600',         idle: 'text-sky-600 border-sky-300 hover:border-sky-500' },
  media:    { active: 'bg-pink-600 text-white border-pink-600',       idle: 'text-pink-600 border-pink-300 hover:border-pink-500' },
  partner:  { active: 'bg-teal-600 text-white border-teal-600',       idle: 'text-teal-600 border-teal-300 hover:border-teal-500' },
  other:    { active: 'bg-slate-600 text-white border-slate-600',     idle: 'text-slate-500 border-slate-300 hover:border-slate-500' },
};
const DEFAULT = { active: 'bg-blue-600 text-white border-blue-600', idle: 'text-blue-600 border-blue-300 hover:border-blue-500' };

export default function FilterBar({ segments, selectedSegment, onSegmentChange, counts, total }: FilterBarProps) {
  const chip = (seg: string, label: string, active: boolean, count?: number) => {
    const p = PALETTE[seg] || DEFAULT;
    return (
      <button
        key={seg || 'all'}
        onClick={() => onSegmentChange(seg)}
        className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium capitalize transition ${
          active ? `${p.active} shadow-sm` : `bg-[var(--bg-raised)] ${p.idle}`
        }`}
      >
        {label}
        {typeof count === 'number' && (
          <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${active ? 'bg-white/25' : 'bg-[var(--bg-surface)] text-[var(--text-secondary)]'}`}>
            {count}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-wrap gap-2">
      {chip('', 'All segments', !selectedSegment, total)}
      {segments.map((seg) => chip(seg, seg, selectedSegment === seg, counts?.[seg]))}
    </div>
  );
}
