import { SelectHTMLAttributes } from 'react';
interface Props extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
}
export default function Dropdown({ label, options, className = '', ...rest }: Props) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">{label}</span>}
      <select
        className={`w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-[border-color,box-shadow] focus:border-[var(--ink)] focus:shadow-[var(--focus-ring)] ${className}`}
        {...rest}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
