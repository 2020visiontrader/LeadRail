import { useState } from 'react';
import { Contact } from '@/lib/types';
import Badge, { statusTone } from '@/components/Badge';

interface DataTableProps {
  contacts: Contact[];
  isLoading?: boolean;
  onRowClick?: (contact: Contact) => void;
  onDelete?: (contact: Contact) => void;
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

  if (isLoading) return <div className="p-8 text-center text-sm text-slate-500">Loading contacts…</div>;
  if (!sorted.length) return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">No contacts match.</div>;

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
          <tr>
            <th className="cursor-pointer p-3 text-left hover:bg-slate-100" onClick={() => toggleSort('name')}>Name{arrow('name')}</th>
            <th className="cursor-pointer p-3 text-left hover:bg-slate-100" onClick={() => toggleSort('email')}>Email{arrow('email')}</th>
            <th className="p-3 text-left">Company</th>
            <th className="cursor-pointer p-3 text-left hover:bg-slate-100" onClick={() => toggleSort('segment')}>Segment{arrow('segment')}</th>
            <th className="cursor-pointer p-3 text-center hover:bg-slate-100" onClick={() => toggleSort('score')}>Score{arrow('score')}</th>
            <th className="p-3 text-left">Status</th>
            <th className="p-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sorted.map((c) => (
            <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onRowClick?.(c)}>
              <td className="p-3 font-medium">{c.name}</td>
              <td className="p-3 text-indigo-600">{c.email}</td>
              <td className="p-3 text-slate-600">{c.company || '—'}</td>
              <td className="p-3"><Badge tone="indigo">{c.segment}</Badge></td>
              <td className="p-3 text-center font-semibold text-green-600">{c.score}</td>
              <td className="p-3"><Badge tone={statusTone(c.status)}>{c.status}</Badge></td>
              <td className="p-3 text-right">
                <button className="mr-3 text-indigo-600 hover:underline" onClick={(e) => { e.stopPropagation(); onRowClick?.(c); }}>Edit</button>
                <button className="text-red-600 hover:underline" onClick={(e) => { e.stopPropagation(); onDelete?.(c); }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
