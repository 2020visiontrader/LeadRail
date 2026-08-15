import { useState, useEffect } from 'react';

interface SearchInputProps {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}

export default function SearchInput({ placeholder = 'Search...', value, onChange }: SearchInputProps) {
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      onChange(localValue);
    }, 300); // Debounce 300ms

    return () => clearTimeout(timer);
  }, [localValue, onChange]);

  return (
    <div className="relative">
      <input
        type="text"
        placeholder={placeholder}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-4 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-[border-color,box-shadow] focus:border-[var(--ink)] focus:shadow-[var(--focus-ring)]"
      />
      {localValue && (
        <button
          onClick={() => setLocalValue('')}
          className="absolute right-3 top-2.5 text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
        >
          ✕
        </button>
      )}
    </div>
  );
}