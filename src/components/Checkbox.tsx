import { InputHTMLAttributes } from 'react';
interface Props extends InputHTMLAttributes<HTMLInputElement> { label: string; }
export default function Checkbox({ label, className = '', ...rest }: Props) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" className={`h-4 w-4 rounded border-slate-300 text-indigo-600 ${className}`} {...rest} />
      {label}
    </label>
  );
}
