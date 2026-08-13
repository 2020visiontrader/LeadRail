'use client';
import { ButtonHTMLAttributes, useRef, useState } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}
// Matte/flat brand buttons: teal-ink primary, red danger, outlined secondary.
// Primary action = --ink (operator teal in dark mode). Blue (--brand) is used
// for links, not primary buttons. Danger = red accent. Matte/flat, one hot
// action per view per DESIGN.md. Hover = brightness shift, not a color swap.
const styles: Record<Variant, string> = {
  primary: 'bg-[var(--ink)] text-[var(--ink-fg)] hover:brightness-110 active:brightness-95',
  secondary: 'border border-[var(--border-strong)] text-[var(--text-primary)] hover:bg-[var(--bg-raised)] active:bg-[var(--bg-raised)]',
  danger: 'text-white bg-[var(--accent)] hover:brightness-110 active:brightness-95',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]',
};
export default function Button({ variant = 'primary', loading, children, className = '', disabled, onClick, ...rest }: Props) {
  // Platform-wide loading: any onClick that returns a promise (an async
  // execution — API call, mutation, generation) auto-spins + disables the
  // button for its duration, so every execution shows feedback without each
  // page wiring its own state. An explicit `loading` prop still forces it on;
  // sync handlers never spin. Double-clicks are guarded while in flight.
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!onClick) return;
    if (inFlight.current) return;
    const result = onClick(e) as unknown;
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      inFlight.current = true;
      setPending(true);
      Promise.resolve(result).finally(() => {
        inFlight.current = false;
        setPending(false);
      });
    }
  };

  const busy = loading || pending;
  return (
    <button
      disabled={disabled || busy}
      onClick={onClick ? handleClick : undefined}
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-[filter,background-color,color] duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
      {...rest}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}
