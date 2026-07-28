'use client';
import { useState, useEffect, useCallback } from 'react';
import DataTable from '@/components/DataTable';
import ContactDrawer from '@/components/ContactDrawer';
import SearchInput from '@/components/SearchInput';
import FilterBar from '@/components/FilterBar';
import Modal from '@/components/Modal';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { Contact, SEGMENTS } from '@/lib/types';

const BRAND = 'rentahub';
const LIMIT = 30;
const emptyLead = { name: '', email: '', company: '', title: '', segment: 'investor' };

export default function LeadsPage() {
  const { notify } = useToast();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(emptyLead);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Contact[]>(`/api/leads?brandId=${BRAND}&limit=${LIMIT}&page=${page}`);
      setContacts(Array.isArray(data) ? data : []);
    } catch (e: any) {
      notify(e.message || 'Failed to load leads', 'error');
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [page, notify]);

  useEffect(() => { load(); }, [load]);

  const filtered = contacts.filter((c) => {
    const s = search.toLowerCase();
    const matchesSearch = c.name.toLowerCase().includes(s) || c.email.toLowerCase().includes(s) || (c.company?.toLowerCase() || '').includes(s);
    return matchesSearch && (!segment || c.segment === segment);
  });

  const openContact = (c: Contact) => { setSelected(c); setDrawerOpen(true); };

  const handleUpdate = async (c: Contact) => {
    try {
      const updated = await apiSend<Contact>(`/api/leads/${c.id}`, 'PATCH', c);
      setContacts((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...updated } : x)));
      notify('Contact updated');
    } catch (e: any) { notify(e.message || 'Update failed', 'error'); }
  };

  const handleDelete = async (c: Contact) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try {
      await apiSend(`/api/leads/${c.id}`, 'DELETE');
      setContacts((prev) => prev.filter((x) => x.id !== c.id));
      notify('Contact deleted');
    } catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  const handleAdd = async () => {
    if (!form.name || !form.email) { notify('Name and email required', 'error'); return; }
    setSaving(true);
    try {
      const created = await apiSend<Contact>('/api/leads', 'POST', { brand_id: BRAND, ...form });
      setContacts((prev) => [created, ...prev]);
      setAddOpen(false); setForm(emptyLead);
      notify('Lead added');
    } catch (e: any) { notify(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  };

  const hasNext = contacts.length === LIMIT;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-slate-500">{filtered.length} shown</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>+ Add Lead</Button>
      </div>

      <div className="space-y-3">
        <SearchInput placeholder="Search by name, email, or company…" value={search} onChange={setSearch} />
        <FilterBar segments={[...SEGMENTS]} selectedSegment={segment} onSegmentChange={setSegment} />
      </div>

      <DataTable contacts={filtered} isLoading={loading} onRowClick={openContact} onDelete={handleDelete} />

      <div className="flex items-center justify-between text-sm text-slate-600">
        <Button variant="secondary" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
        <span>Page {page + 1}</span>
        <Button variant="secondary" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>Next</Button>
      </div>

      <ContactDrawer contact={selected} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} onUpdate={handleUpdate} onDelete={(c) => { setDrawerOpen(false); handleDelete(c); }} />

      <Modal isOpen={addOpen} title="Add Lead" onClose={() => setAddOpen(false)} onSubmit={handleAdd} submitLabel="Create" loading={saving}>
        <div className="space-y-4">
          <Input label="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Email *" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input label="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <Input label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Dropdown label="Segment" value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}
            options={SEGMENTS.map((s) => ({ value: s, label: s }))} />
        </div>
      </Modal>
    </div>
  );
}
