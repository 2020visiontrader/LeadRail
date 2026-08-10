import { useState } from 'react';
import { Contact } from '@/lib/types';
import Badge, { statusTone } from '@/components/Badge';

interface DataTableProps {
  contacts: Contact[];
  isLoading?: boolean;
  onRowClick?: (contact: Contact) => void;
  onDelete?: (contact: Contact) => void;
}

// Deterministic avatar hue from a name — stable per person, no rainbow status
// remap (status pills still route through statusTone). Twenty-style record row.
function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function Avatar({ name }: { name: string }) {
  const hue = avatarHue(name || '?');
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
      style={{
        background: `hsl(${hue} 55% 50% / 0.18)`,
        color: `hsl(${hue} 60% 62%)`,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export default function DataTable({ contacts, isLoading, onRowClick, onDelete }: DataTableProps) {
  const [sortKey, setSortKey] = useState<keyof Contact>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = [...contacts].sort((a, b) => {
    const aVal = a[sortKey] ?? '';
    const bVal = b[sortKey] ?? '';
    const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (key: keyof Contact) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };
  const arrow = (key: keyof Contact) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  if (isLoading)
    return <div className="p-8 text-center text-sm text-[var(--text-muted)]">Loading contacts…</div>;
  if (!sorted.length)
    return (
      <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-raised)] p-10 text-center text-sm text-[var(--text-muted)]">
        No contacts match.
      </div>
    );

  const th = 'p-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]';
  const thSort = `cursor-pointer select-none hover:text-[var(--text-secondary)] ${th}`;

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--border-default)] bg-[var(--bg-raised)]">
          <tr>
            <th className={thSort} onClick={() => toggleSort('name')}>Name{arrow('name')}</th>
            <th className={thSort} onClick={() => toggleSort('email')}>Email{arrow('email')}</th>
            <th className={th}>Company</th>
            <th className={thSort} onClick={() => toggleSort('segment')}>Segment{arrow('segment')}</th>
            <th className={`${thSort} text-center`} onClick={() => toggleSort('score')}>Score{arrow('score')}</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr
              key={c.id}
              className="cursor-pointer border-b border-[var(--border-default)] transition-colors last:border-0 hover:bg-[var(--bg-raised)]"
              onClick={() => onRowClick?.(c)}
            >
              <td className="p-2.5">
                <div className="flex items-center gap-2.5">
                  <Avatar name={c.name} />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-[var(--text-primary)]">{c.name}</div>
                    {c.title && <div className="truncate text-[11px] text-[var(--text-muted)]">{c.title}</div>}
                  </div>
                </div>
              </td>
              <td className="max-w-[16rem] truncate p-2.5 text-[var(--brand)]">{c.email}</td>
              <td className="p-2.5 text-[var(--text-secondary)]">{c.company || '—'}</td>
              <td className="p-2.5"><Badge tone="indigo">{c.segment}</Badge></td>
              <td className="p-2.5 text-center font-semibold text-[var(--status-positive)]">{c.score}</td>
              <td className="p-2.5"><Badge tone={statusTone(c.status)}>{c.status}</Badge></td>
              <td className="p-2.5 text-right whitespace-nowrap">
                <button
                  className="mr-3 text-xs font-medium text-[var(--brand)] hover:underline"
                  onClick={(e) => { e.stopPropagation(); onRowClick?.(c); }}
                >
                  Edit
                </button>
                <button
                  className="text-xs font-medium text-[var(--status-negative)] hover:underline"
                  onClick={(e) => { e.stopPropagation(); onDelete?.(c); }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
