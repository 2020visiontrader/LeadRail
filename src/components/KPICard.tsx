// Token-driven KPI tile — works in both light and dark themes (no hardcoded
// colors). DESIGN.md: label overline (secondary), value 24px/700 (primary),
// optional sub caption + trend chip in success/error.
export default function KPICard({
  label,
  value,
  sub,
  icon,
  trend,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: string;
  trend?: { value: string; dir: 'up' | 'down' };
}) {
  const up = trend?.dir === 'up';
  const trendColor = up ? 'var(--status-positive)' : 'var(--status-negative)';
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          {label}
        </span>
        {icon && <span className="text-lg leading-none">{icon}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-bold text-[var(--text-primary)]">{value}</span>
        {trend && (
          <span className="text-[11px] font-semibold" style={{ color: trendColor }}>
            {up ? '↑' : '↓'} {trend.value}
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-xs text-[var(--text-muted)]">{sub}</div>}
    </div>
  );
}
