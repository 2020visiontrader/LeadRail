export default function Drawer({ isOpen, title, onClose, children }: { isOpen: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto border-l border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-6 py-4">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
          <button onClick={onClose} className="text-lg text-[var(--text-muted)] transition hover:text-[var(--text-primary)]">✕</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
