'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { Contact } from '@/lib/types';

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { notify } = useToast();
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<Contact>(`/api/leads/${id}`).then(setContact).catch((e) => notify(e.message || 'Not found', 'error')).finally(() => setLoading(false));
  }, [id, notify]);

  const save = async () => {
    if (!contact) return;
    setSaving(true);
    try { await apiSend(`/api/leads/${id}`, 'PATCH', contact); notify('Saved'); }
    catch (e: any) { notify(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirm('Delete this contact?')) return;
    try { await apiSend(`/api/leads/${id}`, 'DELETE'); notify('Deleted'); router.push('/leads'); }
    catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  if (loading) return <LoadingSpinner />;
  if (!contact) return (
    <div className="space-y-4">
      <Link href="/leads" className="text-sm text-indigo-600 hover:underline">← Back to leads</Link>
      <p className="text-sm text-slate-500">Contact not found.</p>
    </div>
  );

  return (
    <div className="max-w-2xl space-y-6">
      <Link href="/leads" className="text-sm text-indigo-600 hover:underline">← Back to leads</Link>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{contact.name}</h1>
        <div className="flex items-center gap-2">
          <Badge tone="indigo">{contact.segment}</Badge>
          <span className="text-xl font-bold text-[var(--text-positive)]">{contact.score}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-2">
        <Input label="Name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
        <Input label="Email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
        <Input label="Company" value={contact.company || ''} onChange={(e) => setContact({ ...contact, company: e.target.value })} />
        <Input label="Title" value={contact.title || ''} onChange={(e) => setContact({ ...contact, title: e.target.value })} />
        <Dropdown label="Status" value={contact.status} onChange={(e) => setContact({ ...contact, status: e.target.value as Contact['status'] })}
          options={['new', 'outreaching', 'replied', 'qualified', 'dead'].map((s) => ({ value: s, label: s }))} />
      </div>

      <div className="flex gap-3">
        <Button onClick={save} loading={saving}>Save changes</Button>
        <Button variant="danger" onClick={remove}>Delete</Button>
      </div>
    </div>
  );
}
