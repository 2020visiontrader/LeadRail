import { useState, useEffect } from 'react';
import { Contact } from '@/lib/types';

interface DataTableProps {
  contacts: Contact[];
  isLoading?: boolean;
  onRowClick?: (contact: Contact) => void;
}

export default function DataTable({ contacts, isLoading, onRowClick }: DataTableProps) {
  const [sortKey, setSortKey] = useState<keyof Contact>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = [...contacts].sort((a, b) => {
    const aVal = a[sortKey] ?? "";
    const bVal = b[sortKey] ?? "";
    const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (key: keyof Contact) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  if (isLoading) {
    return <div className="p-4 text-center text-gray-500">Loading contacts...</div>;
  }

  return (
    <div className="overflow-x-auto border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 border-b">
          <tr>
            <th className="p-3 text-left cursor-pointer hover:bg-gray-200" onClick={() => toggleSort('name')}>
              Name {sortKey === 'name' && (sortDir === 'asc' ? '↑' : '↓')}
            </th>
            <th className="p-3 text-left cursor-pointer hover:bg-gray-200" onClick={() => toggleSort('email')}>
              Email {sortKey === 'email' && (sortDir === 'asc' ? '↑' : '↓')}
            </th>
            <th className="p-3 text-left">Company</th>
            <th className="p-3 text-left cursor-pointer hover:bg-gray-200" onClick={() => toggleSort('segment')}>
              Segment {sortKey === 'segment' && (sortDir === 'asc' ? '↑' : '↓')}
            </th>
            <th className="p-3 text-center cursor-pointer hover:bg-gray-200" onClick={() => toggleSort('score')}>
              Score {sortKey === 'score' && (sortDir === 'asc' ? '↑' : '↓')}
            </th>
            <th className="p-3 text-left">Status</th>
            <th className="p-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((contact) => (
            <tr
              key={contact.id}
              className="border-b hover:bg-gray-50 cursor-pointer"
              onClick={() => onRowClick?.(contact)}
            >
              <td className="p-3 font-medium">{contact.name}</td>
              <td className="p-3 text-blue-600">{contact.email}</td>
              <td className="p-3">{contact.company || '—'}</td>
              <td className="p-3 text-sm bg-blue-50">{contact.segment}</td>
              <td className="p-3 text-center font-bold text-green-600">{contact.score}</td>
              <td className="p-3 text-xs">
                <span className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded">{contact.status}</span>
              </td>
              <td className="p-3 text-sm">
                <button className="text-blue-600 hover:underline mr-2">Edit</button>
                <button className="text-red-600 hover:underline">Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}