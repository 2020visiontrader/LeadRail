'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import KPICard from '@/components/KPICard';
import Chart from '@/components/Chart';
import LoadingSpinner from '@/components/LoadingSpinner';
import Badge from '@/components/Badge';
import Modal from '@/components/Modal';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Button from '@/components/Button';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { Contact } from '@/lib/types';
import { LEAD_GOALS, SECTORS } from '@/lib/taxonomy';

interface Venture { id: string; name: string; account_id: string; contact_count?: number }
interface SkillMeta { id: string; name: string; category: string; when: string }
const ALL = 'all';
const AUTO_SKILLS = 'auto'; // let Hermes decide skills per request

const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${n}`);

export default function Overview() {
  const { notify } = useToast();
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [scopeId, setScopeId] = useState<string>(ALL); // 'all' or a brand id
  const [stats, setStats] = useState<any>(null);
  const [recent, setRecent] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  // --- New-venture onboarding wizard ---
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(1); // 1 basics · 2 targeting · 3 deck+skills · 4 result
  const [wName, setWName] = useState('');
  const [wDesc, setWDesc] = useState('');
  const [wGoal, setWGoal] = useState('customers');
  const [wSectors, setWSectors] = useState<string[]>([]);
  const [wSkills, setWSkills] = useState<string[]>([AUTO_SKILLS]);
  const [wDeck, setWDeck] = useState<File | null>(null);
  const [skillCatalog, setSkillCatalog] = useState<SkillMeta[]>([]);
  const [profileResult, setProfileResult] = useState<{ summary?: string; note?: string; deck?: string } | null>(null);
  const deckInput = useRef<HTMLInputElement>(null);

  const resetWizard = () => {
    setStep(1); setWName(''); setWDesc(''); setWGoal('customers');
    setWSectors([]); setWSkills([AUTO_SKILLS]); setWDeck(null); setProfileResult(null);
  };
  const openWizard = () => { resetWizard(); setAddOpen(true); };
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  // Load the skills catalog once so the wizard can offer real skills to enable.
  useEffect(() => {
    apiGet<{ skills: SkillMeta[] }>('/api/skills').then((d) => setSkillCatalog(d.skills || [])).catch(() => {});
  }, []);

  const loadVentures = () =>
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => { setVentures(d.ventures || []); return d.ventures || []; })
      .catch(() => { setVentures([]); return [] as Venture[]; });

  useEffect(() => {
    loadVentures().then((vs) => {
      // Default: wide "All Ventures" preview when >1 venture, else the single one.
      setScopeId((cur) => (cur !== ALL ? cur : vs.length === 1 ? vs[0].id : ALL));
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    const isAll = scopeId === ALL;
    Promise.all([
      apiGet(`/api/overview?brandId=${encodeURIComponent(scopeId)}`).catch(() => null),
      isAll ? Promise.resolve([]) : apiGet<Contact[]>(`/api/leads?brandId=${scopeId}&limit=8`).catch(() => []),
    ]).then(([s, r]) => {
      setStats(s);
      setRecent(Array.isArray(r) ? r : []);
      setLoading(false);
    });
  }, [scopeId, ventures.length]);

  // Footer action: advance the wizard, or on the last input step create the
  // venture (+ upload/profile the deck if one was chosen).
  const wizardNext = async () => {
    if (step === 1) {
      if (!wName.trim()) { notify('Give the venture a name', 'error'); return; }
      setStep(2); return;
    }
    if (step === 2) { setStep(3); return; }
    if (step === 3) { await submitVenture(); return; }
    if (step === 4) { setAddOpen(false); return; } // "Done"
  };

  const submitVenture = async () => {
    setCreating(true);
    try {
      const skills = wSkills.includes(AUTO_SKILLS) ? [AUTO_SKILLS] : wSkills;
      const { venture } = await apiSend<{ venture: Venture }>('/api/ventures', 'POST', {
        name: wName.trim(), description: wDesc.trim() || undefined,
        leadGoal: wGoal, sectors: wSectors, skills,
      });
      await loadVentures();
      setScopeId(venture.id);

      // Optional: upload the deck and let the AI profile the venture.
      if (wDeck) {
        try {
          const fd = new FormData();
          fd.append('file', wDeck);
          const res = await fetch(`/api/ventures/${venture.id}/deck`, { method: 'POST', body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || 'deck upload failed');
          setProfileResult({ summary: data?.profile?.summary, note: data?.note, deck: data?.deck_name });
        } catch (e: any) {
          setProfileResult({ note: `Venture created. Deck couldn't be profiled: ${e.message || 'error'}` });
        }
      } else {
        setProfileResult({ note: 'Venture created. Add a pitch deck later to auto-tailor its lead search.' });
      }
      notify(`Created “${venture.name}”`);
      setStep(4);
    } catch (e: any) { notify(e.message || 'Could not create venture', 'error'); }
    finally { setCreating(false); }
  };

  const stepLabel = step === 1 ? 'Next: targeting' : step === 2 ? 'Next: deck & skills'
    : step === 3 ? (wDeck ? 'Create & profile deck' : 'Create venture') : 'Done';

  const scopeName = scopeId === ALL ? 'All Ventures' : ventures.find((v) => v.id === scopeId)?.name || '—';
  const segEntries = stats?.segments ? Object.entries(stats.segments as Record<string, number>) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <select
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value={ALL}>🌐 All Ventures</option>
            {ventures.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.contact_count ? ` (${v.contact_count})` : ''}</option>
            ))}
          </select>
        </div>
        <Button onClick={openWizard}>+ New venture</Button>
      </div>

      {loading ? (
        <LoadingSpinner label="Loading dashboard…" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <KPICard label="Total Contacts" value={stats?.contacts ?? 0} />
            <KPICard label="Active Deals" value={stats?.deals ?? 0} icon="💼" />
            <KPICard label="Won" value={stats?.won ?? 0} icon="✅" />
            <KPICard label="CVR" value={`${stats?.conversion_rate ?? 0}%`} />
            <KPICard label="Revenue" value={money(stats?.revenue ?? 0)} icon="💰" />
          </div>

          {(stats?.contacts ?? 0) === 0 && (stats?.deals ?? 0) === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--bg-raised)] p-6 text-center text-sm text-[var(--text-secondary)]">
              No data yet for <b>{scopeName}</b> — add leads (Leads → Find Leads / Import) to populate this dashboard.
            </div>
          )}

          {segEntries.length > 0 && (
            <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4">
              <h3 className="mb-3 text-sm font-semibold">Lead segments — {scopeName}</h3>
              <Chart
                data={segEntries.map(([seg, n]) => ({ label: seg, value: n as number }))}
                height={180}
              />
            </div>
          )}

          {scopeId !== ALL && recent.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Recent leads</h3>
              <div className="overflow-hidden rounded-lg border border-[var(--border-strong)]">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--bg-raised)]">
                    <tr>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Company</th>
                      <th className="px-4 py-2 font-medium">Segment</th>
                      <th className="px-4 py-2 font-medium">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-weak)]">
                    {recent.map((c) => (
                      <tr key={c.id} className="hover:bg-[var(--bg-raised)]">
                        <td className="px-4 py-2">{c.name}</td>
                        <td className="px-4 py-2 text-[var(--text-secondary)]">{c.company || '—'}</td>
                        <td className="px-4 py-2"><Badge tone="blue">{c.segment}</Badge></td>
                        <td className="px-4 py-2 font-mono">{c.score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Link href="/leads" className="inline-flex items-center rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white hover:brightness-110">📋 View all leads</Link>
            <Link href="/outreach" className="inline-flex items-center rounded-lg bg-[var(--bg-raised)] px-4 py-2 text-sm font-medium hover:brightness-95">✉️ Send outreach</Link>
            <Link href="/campaigns" className="inline-flex items-center rounded-lg bg-[var(--bg-raised)] px-4 py-2 text-sm font-medium hover:brightness-95">🎯 New campaign</Link>
          </div>
        </>
      )}

      <Modal
        isOpen={addOpen}
        title={step === 4 ? 'Venture created' : `New venture · step ${step} of 3`}
        onClose={() => setAddOpen(false)}
        onSubmit={wizardNext}
        submitLabel={stepLabel}
        loading={creating}
      >
        <div className="space-y-4">
          {/* Step 1 — basics */}
          {step === 1 && (
            <div className="space-y-3">
              <Input label="Venture name" placeholder="e.g. RetentionRail" value={wName} onChange={(e) => setWName(e.target.value)} />
              <Textarea
                label="What is this venture about?"
                placeholder="One or two lines — what it does, who it's for. The AI uses this (plus your deck) to find the right leads."
                rows={3}
                value={wDesc}
                onChange={(e) => setWDesc(e.target.value)}
              />
              <p className="text-xs text-[var(--text-muted)]">A venture is a separate brand workspace — its own leads, sequences, inbox and outreach.</p>
            </div>
          )}

          {/* Step 2 — targeting: lead goal + sectors */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Who are you trying to reach?</span>
                <select
                  value={wGoal}
                  onChange={(e) => setWGoal(e.target.value)}
                  className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                >
                  {LEAD_GOALS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select>
                <p className="mt-1 text-xs text-[var(--text-muted)]">{LEAD_GOALS.find((g) => g.key === wGoal)?.hint}</p>
              </div>
              <div>
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Target sectors <span className="text-[var(--text-muted)]">(pick any)</span></span>
                <div className="flex flex-wrap gap-2">
                  {SECTORS.map((s) => {
                    const on = wSectors.includes(s.key);
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => setWSectors((l) => toggle(l, s.key))}
                        className={`rounded-full border px-3 py-1 text-xs transition ${on ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--brand)]'}`}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Step 3 — deck + skills */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Pitch deck / one-pager <span className="text-[var(--text-muted)]">(optional)</span></span>
                <input
                  ref={deckInput}
                  type="file"
                  accept=".pdf,.pptx,.docx,.doc,.xlsx,.xls,.txt,.md"
                  onChange={(e) => setWDeck(e.target.files?.[0] || null)}
                  className="block w-full text-sm text-[var(--text-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--bg-raised)] file:px-3 file:py-1.5 file:text-sm"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  PDF, PPTX, Word, or Excel. The AI reads it and, with your goal above, builds a tailored lead profile so the Apollo search targets the right people.
                </p>
                {wDeck && <p className="mt-1 text-xs text-[var(--brand)]">Selected: {wDeck.name}</p>}
              </div>
              <div>
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Skills</span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setWSkills([AUTO_SKILLS])}
                    className={`rounded-full border px-3 py-1 text-xs transition ${wSkills.includes(AUTO_SKILLS) ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--brand)]'}`}
                  >
                    🤖 Let Hermes decide
                  </button>
                  {skillCatalog.map((s) => {
                    const on = wSkills.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        title={s.when}
                        onClick={() => setWSkills((l) => { const next = toggle(l.filter((x) => x !== AUTO_SKILLS), s.id); return next.length ? next : [AUTO_SKILLS]; })}
                        className={`rounded-full border px-3 py-1 text-xs transition ${on ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--brand)]'}`}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Hermes routes each task to the right skill + OpenCode Go model automatically. Pick specific skills only to force them on.</p>
              </div>
            </div>
          )}

          {/* Step 4 — result */}
          {step === 4 && (
            <div className="space-y-3">
              <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-raised)] p-3">
                <p className="text-sm font-medium">“{wName}” is ready.</p>
                {profileResult?.deck && <p className="mt-1 text-xs text-[var(--text-muted)]">Deck: {profileResult.deck}</p>}
              </div>
              {profileResult?.summary && (
                <div className="rounded-lg border border-[var(--brand)]/40 bg-[var(--bg-surface)] p-3">
                  <p className="mb-1 text-xs font-semibold text-[var(--brand)]">AI venture profile</p>
                  <p className="text-sm text-[var(--text-secondary)]">{profileResult.summary}</p>
                </div>
              )}
              {profileResult?.note && <p className="text-xs text-[var(--text-muted)]">{profileResult.note}</p>}
              <p className="text-xs text-[var(--text-muted)]">Head to <b>Leads → Find Leads</b> — the Apollo search is pre-filled from this profile.</p>
            </div>
          )}

          {/* Back control (steps 2-3) */}
          {step > 1 && step < 4 && (
            <button type="button" onClick={() => setStep((s) => s - 1)} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]">← Back</button>
          )}
        </div>
      </Modal>
    </div>
  );
}
