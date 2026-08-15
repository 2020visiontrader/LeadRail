'use client';
import { useEffect, useState, useCallback } from 'react';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { type ChatMsg } from '@/components/ChatAssistant';
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

  // Reply assistant state (per active message).
  const [replyChat, setReplyChat] = useState<ChatMsg[]>([]);
  const [replyLoading, setReplyLoading] = useState(false);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => { apiGet<{ ventures: Venture[] }>('/api/ventures').then((d) => { setVentures(d.ventures || []); setAccount((a) => a || d.ventures?.[0]?.account_id || ''); }).catch(() => {}); }, []);
  const load = useCallback(async () => {
    if (!account) return; setLoading(true);
    try { setRows(await apiGet<InboxMessage[]>(`/api/inbox?accountId=${account}`)); }
    catch { setRows([]); } finally { setLoading(false); }
  }, [account]);
  useEffect(() => { load(); }, [load]);

  const openMsg = async (m: InboxMessage) => {
    setActive(m);
    setReplyChat([]); setDraft(null); // fresh reply thread per message
    if (!m.is_read) { try { await apiSend(`/api/inbox/${m.id}`, 'PATCH', { is_read: true }); setRows((r) => r.map((x) => x.id === m.id ? { ...x, is_read: true } : x)); } catch { /* noop */ } }
  };

  const ventureName = ventures.find((v) => v.account_id === account)?.name;

  const sendReplyChat = async (text: string) => {
    if (!active) return;
    const next: ChatMsg[] = [...replyChat, { role: 'user', content: text }];
    setReplyChat(next); setReplyLoading(true);
    try {
      const res = await apiSend<{ reply: string; draft: { subject: string; body: string } | null }>(
        '/api/inbox/reply', 'POST',
        { messages: next, context: { incomingSubject: active.subject, incomingBody: active.body, fromName: active.from_addr, ventureName } },
      );
      setReplyChat([...next, { role: 'assistant', content: res.reply }]);
      if (res.draft) setDraft(res.draft);
    } catch (e: any) {
      const msg = e.message === 'not_configured' ? 'LeadRail AI is temporarily unavailable' : e.message || 'AI failed';
      setReplyChat([...next, { role: 'assistant', content: `⚠️ ${msg}` }]);
    } finally { setReplyLoading(false); }
  };

  const sendReply = async () => {
    if (!active || !draft) return;
    setSending(true);
    try {
      await apiSend(`/api/inbox/${active.id}/send`, 'POST', { subject: draft.subject, body: draft.body });
      notify('Reply sent');
      setDraft(null); setReplyChat([]);
    } catch (e: any) { notify(e.message || 'Send failed', 'error'); }
    finally { setSending(false); }
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
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-white p-5">
                  <div className="mb-2 text-sm text-slate-500">{active.from_addr} → {active.to_addr}</div>
                  <h2 className="text-lg font-semibold">{active.subject || '(no subject)'}</h2>
                  <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{active.body || '(no body)'}</p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <h3 className="mb-2 text-sm font-semibold">Draft a reply with AI</h3>
                  {draft && (
                    <div className="mt-3 space-y-2 rounded-lg border border-green-200 bg-green-50 p-3">
                      <Input label="Subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
                      <Textarea label="Reply body" rows={6} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                      <div className="flex items-center gap-2">
                        <Button onClick={sendReply} loading={sending}>Send reply</Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-400">Select a message</div>}
          </div>
        </div>
      )}
    </div>
  );
}
