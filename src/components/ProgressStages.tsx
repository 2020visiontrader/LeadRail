'use client';
import { useEffect, useState } from 'react';

// Reusable progressive loading indicator. While `active`, it walks through a
// list of plain-language stage messages so the user always sees what the
// system is doing (never a bare spinner). Token-driven; theme-correct.
// The last stage is held until `active` flips false (the real work finishing).
export default function ProgressStages({
  active,
  stages,
  className = '',
  intervalMs = 1100,
}: {
  active: boolean;
  stages: string[];
  className?: string;
  intervalMs?: number;
}) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (!active || stages.length === 0) {
      setI(0);
      return;
    }
    setI(0);
    const id = setInterval(() => {
      setI((p) => (p < stages.length - 1 ? p + 1 : p)); // advance, then hold on the last
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, stages.length, intervalMs]);

  if (!active || stages.length === 0) return null;
  const pct = Math.round(((i + 1) / stages.length) * 100);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)] ${className}`}
    >
      <div className="flex items-center gap-3">
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--brand)] border-t-transparent" />
        <span key={i} className="animate-fade-in text-sm font-medium text-[var(--text-primary)]">
          {stages[i]}
        </span>
        <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{pct}%</span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-raised)]">
        <div
          className="h-full rounded-full bg-[var(--brand)] transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
