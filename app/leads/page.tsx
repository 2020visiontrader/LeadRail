'use client';
import { useState, useEffect, useCallback } from 'react';
import DataTable from '@/components/DataTable';
import ImportExport from '@/components/ImportExport';
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
import type { ApolloCandidate } from '@/lib/integrations/apollo';

const LIMIT = 30;
const emptyLead = { name: '', email: '', company: '', title: '', segment: 'investor' };
const emptyICP = { industry: '', titles: '', seniority: '', location: '', company_size: '', keywords: '', limit: 25 };

interface Venture { id: string; name: string; account_id: string }

export default function LeadsPage() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [venture, setVenture] = useState<Venture | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(emptyLead);
  const [saving, setSaving] = useState(false);

  // --- Apollo sourcing (fully user-driven; nothing runs until the user clicks) ---
  const [sourceOpen, setSourceOpen] = useState(false);
  const [icp, setIcp] = useState(emptyICP);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ApolloCandidate[] | null>(null);
  const [totalMatches, setTotalMatches] = useState(0);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [importing, setImporting] = useState(false);

  // Load ventures once (for the scope selector). Does NOT touch Apollo.
  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => {
        const vs = d.ventures || [];
        setVentures(vs);
        setVenture((cur) => cur || vs[0] || null);
      })
      .catch(() => setVentures([]));
  }, []);

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    try {
      const data = await apiGet<Contact[]>(`/api/leads?brandId=${venture.id}&limit=${LIMIT}&page=${page}`);
      setContacts(Array.isArray(data) ? data : []);
    } catch (e: any) {
      notify(e.message || 'Failed to load leads', 'error');
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [venture, page, notify]);

  // Loads existing saved contacts for the venture — this reads the DB, it does
  // NOT source from Apollo. Apollo is only ever hit by handleApolloSearch below.
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
    if (!venture) { notify('Select a venture first', 'error'); return; }
    setSaving(true);
    try {
      const created = await apiSend<Contact>('/api/leads', 'POST', { brand_id: venture.id, ...form });
      setContacts((prev) => [created, ...prev]);
      setAddOpen(false); setForm(emptyLead);
      notify('Lead added');
    } catch (e: any) { notify(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  };

  // USER-TRIGGERED Apollo search. Fires only from the Search button click.
  const handleApolloSearch = async () => {
    if (!venture) { notify('Select a venture first', 'error'); return; }
    const query: any = {
      industry: icp.industry.trim() || undefined,
      titles: icp.titles.split(',').map((t) => t.trim()).filter(Boolean),
      seniority: icp.seniority.split(',').map((t) => t.trim()).filter(Boolean),
      location: icp.location.trim() || undefined,
      company_size: icp.company_size.trim() || undefined,
      keywords: icp.keywords.trim() || undefined,
      limit: Number(icp.limit) || 25,
    };
    if (!query.titles.length && !query.industry && !query.keywords) {
      notify('Describe an ICP: at least industry, titles, or keywords', 'error');
      return;
    }
    setSearching(true); setResults(null); setPicked({});
    try {
      const data = await apiSend<{ candidates: ApolloCandidate[]; total: number }>(
        '/api/leads/apollo/search', 'POST',
        { accountId: venture.account_id, brandId: venture.id, query }
      );
      setResults(data.candidates || []);
      setTotalMatches(data.total || 0);
      if (!data.candidates?.length) notify('No matches — widen the ICP', 'info');
    } catch (e: any) {
      notify(e.message || 'Apollo search failed', 'error');
      setResults([]);
    } finally { setSearching(false); }
  };

  // USER-TRIGGERED import of the rows the user checked. Nothing auto-imports.
  const handleImport = async () => {
    if (!venture || !results) return;
    const chosen = results.filter((c) => picked[c.external_id || c.name]);
    if (!chosen.length) { notify('Select at least one lead to import', 'error'); return; }
    setImporting(true);
    try {
      const data = await apiSend<{ imported: number; skipped: number }>(
        '/api/leads/apollo/import', 'POST',
        { accountId: venture.account_id, brandId: venture.id, candidates: chosen }
      );
      notify(`Imported ${data.imported}${data.skipped ? `, ${data.skipped} already existed` : ''}`);
      setResults(null); setPicked({}); setSourceOpen(false);
      await load();
    } catch (e: any) { notify(e.message || 'Import failed', 'error'); }
    finally { setImporting(false); }
  };

  const handleEnrich = async (c: Contact) => {
    try {
      notify('Enriching…', 'info');
      const updated = await apiSend<Contact>(`/api/leads/${c.id}/enrich`, 'POST');
      setContacts((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...updated } : x)));
      notify('Enriched');
    } catch (e: any) { notify(e.message || 'Enrich failed', 'error'); }
  };

  const allPicked = results ? results.length > 0 && results.every((c) => picked[c.external_id || c.name]) : false;
  const toggleAll = () => {
    if (!results) return;
    const next: Record<string, boolean> = {};
    if (!allPicked) results.forEach((c) => { next[c.external_id || c.name] = true; });
    setPicked(next);
  };

  const hasNext = contacts.length === LIMIT;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-slate-500">{filtered.length} shown</p>
        </div>
        <div className="flex items-center gap-2">
          <Dropdown
            value={venture?.id || ''}
            onChange={(e) => { setVenture(ventures.find((v) => v.id === e.target.value) || null); setPage(0); }}
            options={ventures.map((v) => ({ value: v.id, label: v.name }))}
          />
          <Button variant="secondary" onClick={() => setSourceOpen((o) => !o)}>Find Leads (Apollo)</Button>
          <Button onClick={() => setAddOpen(true)}>+ Add Lead</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <span className="text-xs text-slate-500">Bulk: import a CSV/Excel list, or export the current venture&apos;s leads.</span>
        <ImportExport exportPath="/api/leads/export" importPath="/api/leads/import" brandId={venture?.id} accountId={venture?.account_id} onImported={load} />
      </div>

      {sourceOpen && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Source leads from Apollo</h2>
            <span className="text-xs text-slate-500">Nothing is pulled until you click Search</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Industry" placeholder="e.g. marketing" value={icp.industry} onChange={(e) => setIcp({ ...icp, industry: e.target.value })} />
            <Input label="Titles (comma-sep)" placeholder="Founder, CEO" value={icp.titles} onChange={(e) => setIcp({ ...icp, titles: e.target.value })} />
            <Input label="Seniority (comma-sep)" placeholder="owner, c_suite" value={icp.seniority} onChange={(e) => setIcp({ ...icp, seniority: e.target.value })} />
            <Input label="Location" placeholder="United States" value={icp.location} onChange={(e) => setIcp({ ...icp, location: e.target.value })} />
            <Input label="Company size" placeholder="startup / smb / mid / enterprise" value={icp.company_size} onChange={(e) => setIcp({ ...icp, company_size: e.target.value })} />
            <Input label="Keywords" placeholder="B2B SaaS" value={icp.keywords} onChange={(e) => setIcp({ ...icp, keywords: e.target.value })} />
          </div>
          <div className="flex items-center gap-3">
            <Input label="Limit" type="number" value={String(icp.limit)} onChange={(e) => setIcp({ ...icp, limit: Number(e.target.value) })} />
            <div className="pt-6">
              <Button onClick={handleApolloSearch} loading={searching}>Search Apollo</Button>
            </div>
          </div>

          {results && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600">
                  {results.length} preview{results.length === 1 ? '' : 's'}
                  {totalMatches > results.length ? ` of ~${totalMatches.toLocaleString()} matches` : ''}
                </span>
                <div className="flex items-center gap-2">
                  <button type="button" className="text-slate-600 underline" onClick={toggleAll}>
                    {allPicked ? 'Clear all' : 'Select all'}
                  </button>
                  <Button onClick={handleImport} loading={importing}>Import selected</Button>
                </div>
              </div>
              <div className="max-h-72 overflow-auto rounded border border-slate-200 bg-white divide-y divide-slate-100">
                {results.length === 0 && <div className="p-3 text-sm text-slate-500">No matches. Widen the ICP.</div>}
                {results.map((c) => {
                  const key = c.external_id || c.name;
                  return (
                    <label key={key} className="flex items-center gap-3 p-2 text-sm hover:bg-slate-50 cursor-pointer">
                      <input type="checkbox" checked={!!picked[key]} onChange={(e) => setPicked((p) => ({ ...p, [key]: e.target.checked }))} />
                      <span className="flex-1">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-slate-500"> — {c.title || '—'} @ {c.company || '—'}</span>
                      </span>
                      <span className={`text-xs ${c.email_status === 'verified' ? 'text-green-600' : c.email_status === 'locked' ? 'text-amber-600' : 'text-slate-400'}`}>
                        {c.email_status === 'verified' ? 'email ✓' : c.email_status === 'locked' ? 'email locked' : 'no email'}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500">
                Previews show masked names and locked emails. Import, then Enrich a lead to unlock full contact data (uses Apollo credits).
              </p>
            </div>
          )}
        </div>
      )}

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

      <ContactDrawer contact={selected} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} onUpdate={handleUpdate} onDelete={(c) => { setDrawerOpen(false); handleDelete(c); }} onEnrich={handleEnrich} />

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
