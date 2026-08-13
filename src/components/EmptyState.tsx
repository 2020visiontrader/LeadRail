export default function EmptyState({ icon = '📭', title, hint, action }: { icon?: string; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-raised)] p-12 text-center">
      <div className="text-3xl opacity-60">{icon}</div>
      <h3 className="mt-3 text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
      {hint && <p className="mt-1 max-w-sm text-[13px] text-[var(--text-muted)]">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
