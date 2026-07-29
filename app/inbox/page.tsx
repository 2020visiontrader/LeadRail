'use client';
import { useEffect, useState, useCallback } from 'react';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { InboxMessage } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }

export default function InboxPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [account, setAccount] = useState<string>('');
  const [rows, setRows] = useState<InboxMessage[]>([]);
  const [active, setActive] = useState<InboxMessage | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => { setVentures(d.ventures || []); setAccount((a) => a || d.ventures?.[0]?.account_id || ''); }).catch(() => {}); }, []);
  const load = useCallback(async () => {
    if (!account) return; setLoading(true);
    try { setRows(await apiGet<InboxMessage[]>(`/api/inbox?accountId=${account}`)); }
    catch { setRows([]); } finally { setLoading(false); }
  }, [account]);
  useEffect(() => { load(); }, [load]);

  const openMsg = async (m: InboxMessage) => {
    setActive(m);
    if (!m.is_read) { try { await apiSend(`/api/inbox/${m.id}`, 'PATCH', { is_read: true }); setRows((r) => r.map((x) => x.id === m.id ? { ...x, is_read: true } : x)); } catch { /* noop */ } }
  };

  const accounts = Array.from(new Map(ventures.map((v) => [v.account_id, v])).values());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Inbox</h1><p className="text-sm text-slate-500">Replies to every email you send land here. Connect an email account in Settings to sync.</p></div>
        {accounts.length > 1 && <Dropdown value={account} onChange={(e) => setAccount(e.target.value)} options={accounts.map((v) => ({ value: v.account_id, label: v.name }))} />}
      </div>
      {loading ? <LoadingSpinner /> : rows.length === 0 ? (
        <EmptyState icon="📥" title="Inbox empty" hint="No messages yet. Sent outreach and their replies will appear here once an email account is connected." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <ul className="space-y-2 lg:col-span-1">
            {rows.map((m) => (
              <li key={m.id}>
                <button onClick={() => openMsg(m)} className={`w-full rounded-lg border p-3 text-left text-sm ${active?.id === m.id ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                  <div className="flex items-center justify-between">
                    <span className={m.is_read ? 'text-slate-600' : 'font-semibold'}>{m.from_addr || m.to_addr || '—'}</span>
                    <Badge tone={m.direction === 'inbound' ? 'blue' : 'gray'}>{m.direction}</Badge>
                  </div>
                  <div className="truncate text-xs text-slate-500">{m.subject || '(no subject)'}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="lg:col-span-2">
            {active ? (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="mb-2 text-sm text-slate-500">{active.from_addr} → {active.to_addr}</div>
                <h2 className="text-lg font-semibold">{active.subject || '(no subject)'}</h2>
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{active.body || '(no body)'}</p>
              </div>
            ) : <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-400">Select a message</div>}
          </div>
        </div>
      )}
    </div>
  );
}
