export default function LoadingSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-[var(--text-secondary)]">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-strong)]"
        style={{ borderTopColor: 'var(--ink)' }}
      />
      {label}
    </div>
  );
}
