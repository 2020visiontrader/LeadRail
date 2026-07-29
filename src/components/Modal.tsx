import Button from '@/components/Button';
interface ModalProps {
  isOpen: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  loading?: boolean;
  maxWidth?: string;
}
export default function Modal({ isOpen, title, children, onClose, onSubmit, submitLabel = 'Submit', loading, maxWidth = 'max-w-lg' }: ModalProps) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'var(--scrim)' }} onClick={onClose}>
      <div className={`w-full ${maxWidth} rounded-xl bg-[var(--bg-surface)] shadow-[var(--shadow-pop)] border border-[var(--border-default)]`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-xl text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="px-6 py-5">{children}</div>
        <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {onSubmit && <Button onClick={onSubmit} loading={loading}>{submitLabel}</Button>}
        </div>
      </div>
    </div>
  );
}
