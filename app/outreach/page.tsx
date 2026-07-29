'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import Button from '@/components/Button';
import Modal from '@/components/Modal';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { Contact, EmailCampaign } from '@/lib/types';

interface Venture { id: string; name: string; account_id: string }

export default function OutreachPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({ contactId: '', subject: '', html: '' });
  const [goal, setGoal] = useState('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => { const vs = d.ventures || []; setVentures(vs); setVenture((cur) => cur || vs[0] || null); })
      .catch(() => setVentures([]));
  }, []);

  const generate = async () => {
    if (!goal.trim()) { notify('Describe the goal of the email', 'error'); return; }
    setGenerating(true);
    try {
      const contact = contacts.find((c) => c.id === form.contactId);
      const r = await apiSend<{ draft: { subject: string; body: string } }>('/api/generate/outreach', 'POST', {
        venture: { name: venture?.name || '' }, goal: goal.trim(),
        contact: contact ? { name: contact.name, title: contact.title, company: contact.company } : {},
      });
      setForm((f) => ({ ...f, subject: r.draft.subject || f.subject, html: r.draft.body || f.html }));
      notify('Draft generated');
    } catch (e: any) {
      notify(e.message === 'not_configured' ? 'Connect Gemini to generate' : e.message || 'Generation failed', 'error');
    } finally { setGenerating(false); }
  };

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    const [c, k] = await Promise.all([
      apiGet<EmailCampaign[]>('/api/outreach').catch(() => []),
      apiGet<Contact[]>(`/api/leads?brandId=${venture.id}&limit=100`).catch(() => []),
    ]);
    setCampaigns(Array.isArray(c) ? c : []);
    setContacts(Array.isArray(k) ? k : []);
    setLoading(false);
  }, [venture]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!form.contactId || !form.subject) { notify('Pick a contact and subject', 'error'); return; }
    setSending(true);
    try {
      await apiSend('/api/outreach/send', 'POST', form);
      notify('Email sent');
      setOpen(false); setForm({ contactId: '', subject: '', html: '' });
      load();
    } catch (e: any) { notify(e.message || 'Send failed', 'error'); }
    finally { setSending(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold">Outreach</h1>
            <p className="text-sm text-slate-500">Email campaigns</p>
          </div>
          {ventures.length > 1 && (
            <select
              value={venture?.id || ''}
              onChange={(e) => setVenture(ventures.find((v) => v.id === e.target.value) || null)}
              className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            >
              {ventures.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex gap-2">
          <Link href="/outreach/templates"><Button variant="secondary">Templates</Button></Link>
          <Button onClick={() => setOpen(true)}>Compose</Button>
        </div>
      </div>

      {loading ? <LoadingSpinner /> : campaigns.length === 0 ? (
        <EmptyState icon="📧" title="No emails sent yet" hint="Compose your first outreach email. Requires Brevo + Supabase connected to actually send." action={<Button onClick={() => setOpen(true)}>Compose</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr><th className="p-3 text-left">Subject</th><th className="p-3 text-left">Status</th><th className="p-3 text-left">Sent</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="p-3 font-medium">{c.subject || '(no subject)'}</td>
                  <td className="p-3"><Badge tone={c.status === 'opened' ? 'green' : c.status === 'bounced' ? 'red' : 'blue'}>{c.status}</Badge></td>
                  <td className="p-3 text-slate-500">{c.sent_at ? new Date(c.sent_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={open} title="Compose Email" onClose={() => setOpen(false)} onSubmit={send} submitLabel="Send" loading={sending}>
        <div className="space-y-4">
          <Dropdown label="Recipient" value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}
            options={[{ value: '', label: 'Select a contact…' }, ...contacts.map((c) => ({ value: c.id, label: `${c.name} — ${c.email}` }))]} />
          <div className="flex items-end gap-2 rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
            <div className="flex-1"><Input label="AI goal" placeholder="e.g. book a 15-min intro call" value={goal} onChange={(e) => setGoal(e.target.value)} /></div>
            <Button variant="secondary" loading={generating} onClick={generate}>✨ Generate</Button>
          </div>
          <Input label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <Textarea label="Body (HTML)" rows={5} value={form.html} onChange={(e) => setForm({ ...form, html: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
