import { InputHTMLAttributes } from 'react';
interface Props extends InputHTMLAttributes<HTMLInputElement> { label?: string; }
export default function Input({ label, className = '', ...rest }: Props) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">{label}</span>}
      <input
        className={`w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-[border-color,box-shadow] focus:border-[var(--ink)] focus:shadow-[var(--focus-ring)] ${className}`}
        {...rest}
      />
    </label>
  );
}
