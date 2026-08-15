import { InputHTMLAttributes } from 'react';
interface Props extends InputHTMLAttributes<HTMLInputElement> { label: string; }
export default function Checkbox({ label, className = '', ...rest }: Props) {
  return (
    <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <input
        type="checkbox"
        className={`h-4 w-4 rounded border-[var(--border-strong)] bg-[var(--bg-canvas)] text-[var(--ink)] accent-[var(--ink)] focus:ring-2 focus:ring-[var(--focus-ring)] ${className}`}
        {...rest}
      />
      {label}
    </label>
  );
}
