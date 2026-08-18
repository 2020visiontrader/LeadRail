'use client';
import { useEffect, useRef } from 'react';
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

/**
 * Centred dialog that is ALWAYS escapable.
 *
 * The previous version had no max-height and no internal scroller, so any long
 * body (a harvested skill's instructions, for example) made the card taller than
 * the viewport. Combined with `items-center`, that centred an over-tall card and
 * pushed its header — and the ✕ — above the top edge, off-screen. There was then
 * no way to close it: no Escape handler, and the Cancel button was below the
 * fold too. The user was trapped.
 *
 * Three things prevent that now, and each is independently sufficient:
 *   1. the card is capped at the viewport and its BODY scrolls, so the header
 *      and footer are always on screen at any content length;
 *   2. Escape closes;
 *   3. the backdrop click already closed, and still does.
 *
 * Sizing is responsive rather than fixed: full-width with a small inset on
 * phones, capped by `maxWidth` from a breakpoint up, and height driven by
 * viewport units so it adapts to short laptop screens as well as tall monitors.
 */
export default function Modal({
  isOpen, title, children, onClose, onSubmit, submitLabel = 'Submit', loading, maxWidth = 'max-w-lg',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape always closes. Registered on the document so it works regardless of
  // where focus sits inside the dialog.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Don't let the page behind scroll while a dialog is open — on a short screen
  // that reads as the dialog itself drifting.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  useEffect(() => { if (isOpen) panelRef.current?.focus(); }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
      style={{ background: 'var(--scrim)' }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-pop)] outline-none sm:max-h-[calc(100dvh-2rem)] ${maxWidth}`}
      >
        {/* shrink-0: the header must never be the thing that scrolls away. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-default)] px-4 py-3 sm:px-6 sm:py-4">
          <h2 className="min-w-0 truncate text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 shrink-0 rounded-md px-2 py-1 text-lg leading-none text-[var(--text-muted)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>

        {/* The only scroller. min-h-0 is required for it to shrink inside flex. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">{children}</div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-[var(--border-default)] px-4 py-3 sm:px-6 sm:py-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {onSubmit && <Button onClick={onSubmit} loading={loading}>{submitLabel}</Button>}
        </div>
      </div>
    </div>
  );
}
