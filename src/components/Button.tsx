import { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}
// Matte/flat brand buttons: blue primary, red danger, outlined secondary.
// Primary action = ink (near-black light / beige dark). Blue is used for links,
// not primary buttons. Danger = red accent. Matte/flat, soft radius.
const styles: Record<Variant, string> = {
  primary: 'bg-[var(--ink)] text-[var(--ink-fg)] hover:bg-[var(--ink-hover)]',
  secondary: 'border border-[var(--border-strong)] text-[var(--text-primary)] hover:bg-[var(--bg-raised)]',
  danger: 'text-white bg-[var(--accent)] hover:brightness-95',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)]',
};
export default function Button({ variant = 'primary', loading, children, className = '', disabled, ...rest }: Props) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
      {...rest}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}
