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

interface Venture { id: string; name: string; account_id: string; contact_count?: number; icp_profile?: any; deck_summary?: string; lead_goal?: string }

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
  const [query, setQuery] = useState(''); // debounced server-side search term
  const [segment, setSegment] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
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
  // Conversational sourcing: describe the ICP in plain language, AI fills the form.
  const [nlQuery, setNlQuery] = useState('');
  const [parsing, setParsing] = useState(false);
  const [nlSummary, setNlSummary] = useState('');

  const buildFromText = async () => {
    if (!nlQuery.trim()) { notify('Describe who you want to reach', 'error'); return; }
    setParsing(true); setNlSummary('');
    try {
      const { icp: parsed } = await apiSend<{ icp: any }>('/api/leads/apollo/parse', 'POST', { text: nlQuery.trim() });
      setIcp({
        industry: parsed.industry || '',
        titles: (parsed.titles || []).join(', '),
        seniority: (parsed.seniority || []).join(', '),
        location: parsed.location || '',
        company_size: parsed.company_size || '',
        keywords: parsed.keywords || '',
        limit: parsed.limit || 25,
      });
      setNlSummary(parsed.summary || '');
      notify('Search built — review and hit Search Apollo');
    } catch (e: any) {
      notify(e.message === 'not_configured' ? 'Connect OpenCode to use plain-language search' : e.message || 'Could not parse', 'error');
    } finally { setParsing(false); }
  };

  // Prefill the Apollo form from the venture's stored ICP profile (derived from
  // its pitch deck + lead goal + sectors at onboarding). Lets a user source
  // tailored leads without hand-tuning any filter.
  const hasProfile = Boolean(venture?.icp_profile && Object.keys(venture.icp_profile).length);
  const applyVentureProfile = () => {
    const p = venture?.icp_profile;
    if (!p) return;
    setIcp({
      industry: p.industry || '',
      titles: Array.isArray(p.titles) ? p.titles.join(', ') : (p.titles || ''),
      seniority: Array.isArray(p.seniority) ? p.seniority.join(', ') : (p.seniority || ''),
      location: p.location || '',
      company_size: p.company_size || '',
      keywords: p.keywords || '',
      limit: 25,
    });
    setNlSummary(venture?.deck_summary ? `Tailored from ${venture.name}: ${venture.deck_summary}` : `Tailored from ${venture?.name}'s profile`);
  };
  // Auto-prefill the first time the panel opens for a venture that has a profile
  // and the form is still untouched (never clobber the user's own edits).
  useEffect(() => {
    const empty = !icp.industry && !icp.titles && !icp.seniority && !icp.keywords;
    if (sourceOpen && hasProfile && empty) applyVentureProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceOpen, venture?.id]);

  // Load ventures once (for the scope selector). Does NOT touch Apollo.
  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => {
        const vs = d.ventures || [];
        setVentures(vs);
        // Default to the venture that actually has leads (most contacts), so the
        // page never opens on an empty brand while data sits under another.
        const preferred = [...vs].sort(
          (a, b) => (b.contact_count || 0) - (a.contact_count || 0)
        )[0];
        setVenture((cur) => cur || preferred || vs[0] || null);
      })
      .catch(() => setVentures([]));
  }, []);

  // Debounce the search box, then run the search on the SERVER so it covers the
  // whole list — not just the ~30 rows currently loaded.
  useEffect(() => {
    const t = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    if (!venture) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ brandId: venture.id, limit: String(LIMIT), page: String(page) });
      if (segment) params.set('segment', segment);
      if (query) params.set('q', query);
      const data = await apiGet<Contact[]>(`/api/leads?${params.toString()}`);
      setContacts(Array.isArray(data) ? data : []);
    } catch (e: any) {
      notify(e.message || 'Failed to load leads', 'error');
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [venture, page, segment, query, notify]);

  // Loads existing saved contacts for the venture — this reads the DB, it does
  // NOT source from Apollo. Apollo is only ever hit by handleApolloSearch below.
  useEffect(() => { load(); }, [load]);

  // Per-segment counts for the filter chips (from the account-scoped overview).
  useEffect(() => {
    if (!venture) { setCounts({}); return; }
    apiGet<{ segments?: Record<string, number> }>(`/api/overview?brandId=${venture.id}`)
      .then((d) => setCounts(d.segments || {}))
      .catch(() => setCounts({}));
  }, [venture, contacts.length]);

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const onSegment = (s: string) => { setSegment(s); setPage(0); };

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

  const isAll = venture?.id === 'all';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-slate-500">{contacts.length} shown{segment ? ` · ${segment}` : ''}{query ? ` · “${query}”` : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <Dropdown
            value={venture?.id || ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'all') {
                setVenture({ id: 'all', name: 'All Ventures', account_id: ventures[0]?.account_id || '' } as Venture);
              } else {
                setVenture(ventures.find((v) => v.id === val) || null);
              }
              setPage(0);
            }}
            options={[{ value: 'all', label: '🌐 All Ventures' }, ...ventures.map((v) => ({ value: v.id, label: v.name }))]}
          />
          <Button variant="secondary" disabled={isAll} title={isAll ? 'Pick a specific venture to source leads' : undefined} onClick={() => setSourceOpen((o) => !o)}>Find Leads (Apollo)</Button>
          <Button disabled={isAll} title={isAll ? 'Pick a specific venture to add a lead' : undefined} onClick={() => setAddOpen(true)}>+ Add Lead</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <span className="text-xs text-slate-500">{isAll ? 'Viewing all ventures — pick a specific venture to import or export.' : 'Bulk: import a CSV/Excel list, or export the current venture’s leads.'}</span>
        {!isAll && <ImportExport exportPath="/api/leads/export" importPath="/api/leads/import" brandId={venture?.id} accountId={venture?.account_id} onImported={load} />}
      </div>

      {sourceOpen && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Source leads from Apollo</h2>
            <div className="flex items-center gap-2">
              {hasProfile && (
                <Button variant="secondary" onClick={applyVentureProfile} title="Fill filters from this venture's pitch-deck profile">
                  ✨ Use {venture?.name} profile
                </Button>
              )}
              <span className="text-xs text-slate-500">Nothing is pulled until you click Search</span>
            </div>
          </div>

          <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 space-y-2">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label="✨ Describe who you want to reach (plain language)"
                  placeholder="e.g. Series A SaaS founders and CEOs in the US"
                  value={nlQuery}
                  onChange={(e) => setNlQuery(e.target.value)}
                  onKeyDown={(e: any) => { if (e.key === 'Enter') buildFromText(); }}
                />
              </div>
              <Button variant="secondary" loading={parsing} onClick={buildFromText}>Build search</Button>
            </div>
            {parsing && <p className="text-xs text-indigo-700">Analyzing your audience and filling the filters… this can take 15–20s.</p>}
            {!parsing && nlSummary && <p className="text-xs text-indigo-700">→ {nlSummary}</p>}
            <p className="text-[11px] text-slate-500">The AI fills the filters below — review, tweak, then Search Apollo.</p>
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
        <FilterBar segments={[...SEGMENTS]} selectedSegment={segment} onSegmentChange={onSegment} counts={counts} total={totalCount} />
      </div>

      <DataTable contacts={contacts} isLoading={loading} onRowClick={openContact} onDelete={handleDelete} />

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
