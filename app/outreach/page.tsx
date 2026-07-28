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

const BRAND = 'rentahub';

export default function OutreachPage() {
  const { notify } = useToast();
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({ contactId: '', subject: '', html: '' });

  const load = useCallback(async () => {
    setLoading(true);
    const [c, k] = await Promise.all([
      apiGet<EmailCampaign[]>('/api/outreach').catch(() => []),
      apiGet<Contact[]>(`/api/leads?brandId=${BRAND}&limit=100`).catch(() => []),
    ]);
    setCampaigns(Array.isArray(c) ? c : []);
    setContacts(Array.isArray(k) ? k : []);
    setLoading(false);
  }, []);
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
        <div>
          <h1 className="text-2xl font-bold">Outreach</h1>
          <p className="text-sm text-slate-500">Email campaigns</p>
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
          <Input label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <Textarea label="Body (HTML)" rows={5} value={form.html} onChange={(e) => setForm({ ...form, html: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
