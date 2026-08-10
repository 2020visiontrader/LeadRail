// Lightweight dependency-free bar chart. Token-driven (theme-correct in light
// and dark). Bars use the brand token by default; pass `color` for a CSS color
// or var per chart. `showValues` prints the value above each bar.
export default function Chart({
  data,
  height = 140,
  color = 'var(--brand)',
  showValues = false,
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  showValues?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barArea = height - (showValues ? 40 : 24);
  return (
    <div className="flex items-end gap-3" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center justify-end gap-1">
          {showValues && (
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">{d.value}</span>
          )}
          <div
            className="w-full rounded-t transition-[height] duration-300"
            style={{
              height: `${Math.max(2, (d.value / max) * barArea)}px`,
              background: `linear-gradient(to top, ${color}, color-mix(in srgb, ${color} 65%, transparent))`,
            }}
            title={`${d.label}: ${d.value}`}
          />
          <span className="max-w-full truncate text-[10px] text-[var(--text-muted)]" title={d.label}>
            {d.label}
          </span>
        </div>
      ))}
    </div>
  );
}
