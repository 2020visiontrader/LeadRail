import { InputHTMLAttributes } from 'react';
interface Props extends InputHTMLAttributes<HTMLInputElement> { label?: string; }
export default function Input({ label, className = '', ...rest }: Props) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>}
      <input
        className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 ${className}`}
        {...rest}
      />
    </label>
  );
}
