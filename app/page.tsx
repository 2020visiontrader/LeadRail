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
import CommandBar from '@/components/CommandBar';
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
      // Default: wide "All Brands" preview when >1 venture, else the single one.
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
      if (!wName.trim()) { notify('Give the brand a name', 'error'); return; }
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
        // No deck — still profile from the basics (name + description + goal +
        // sectors) so the venture has grounded context for the AI prompt boxes
        // from day one. Best-effort: a profiling hiccup never blocks creation.
        try {
          const res = await fetch(`/api/ventures/${venture.id}/profile`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
          });
          const data = await res.json();
          if (res.ok) {
            await loadVentures();
            setProfileResult({ summary: data?.profile?.summary, note: 'Profiled from your description — its lead search and AI boxes are now tailored. Add a pitch deck anytime for a deeper profile.' });
          } else {
            setProfileResult({ note: 'Brand created. Add a pitch deck later to auto-tailor its lead search.' });
          }
        } catch {
          setProfileResult({ note: 'Brand created. Add a pitch deck later to auto-tailor its lead search.' });
        }
      }
      notify(`Created “${venture.name}”`);
      setStep(4);
    } catch (e: any) { notify(e.message || 'Could not create brand', 'error'); }
    finally { setCreating(false); }
  };

  const stepLabel = step === 1 ? 'Next: targeting' : step === 2 ? 'Next: deck & focus'
    : step === 3 ? (wDeck ? 'Create & profile deck' : 'Create brand') : 'Done';

  const scopeName = scopeId === ALL ? 'All Brands' : ventures.find((v) => v.id === scopeId)?.name || '—';
  const segEntries = stats?.segments ? Object.entries(stats.segments as Record<string, number>) : [];

  const firstRun = !loading && ventures.length === 0;

  return (
    <div className="space-y-6">
      {/* Header hidden on first run — the activation hero carries the title + CTA */}
      {!firstRun && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <select
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            >
              <option value={ALL}>🌐 All Brands</option>
              {ventures.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.contact_count ? ` (${v.contact_count})` : ''}</option>
              ))}
            </select>
          </div>
          <Button onClick={openWizard}>+ New brand</Button>
        </div>
      )}

      {loading ? (
        <LoadingSpinner label="Loading dashboard…" />
      ) : firstRun ? (
        <FirstRunHero onStart={openWizard} />
      ) : (
        <>
          <CommandBar ventureName={scopeName} />
          <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <KPICard label="Total Contacts" value={stats?.contacts ?? 0} icon="👥" sub={`${stats?.emails ?? 0} emails sent`} />
            <KPICard label="Open Pipeline" value={money(stats?.pipeline_value ?? 0)} icon="💼" sub={`${stats?.deals ?? 0} open deals`} />
            <KPICard label="Won" value={stats?.won ?? 0} icon="✅" sub={`${stats?.lost ?? 0} lost`} />
            <KPICard label="Conversion" value={`${stats?.conversion_rate ?? 0}%`} icon="📈" sub="won ÷ contacts" />
            <KPICard label="Revenue" value={money(stats?.revenue ?? 0)} icon="💰" sub="won deals" />
          </div>

          {(stats?.contacts ?? 0) === 0 && (stats?.deals ?? 0) === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--bg-raised)] p-6 text-center text-sm text-[var(--text-secondary)]">
              No data yet for <b>{scopeName}</b> — add leads (Leads → Find Leads / Import) to populate this dashboard.
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)]">
              <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">Lead segments — {scopeName}</h3>
              {segEntries.length > 0 ? (
                <Chart
                  data={segEntries.map(([seg, n]) => ({ label: seg, value: n as number }))}
                  height={200}
                  showValues
                />
              ) : (
                <p className="py-10 text-center text-sm text-[var(--text-muted)]">No segmented leads yet.</p>
              )}
            </div>
            <PipelineHealth
              open={stats?.deals ?? 0}
              won={stats?.won ?? 0}
              lost={stats?.lost ?? 0}
              pipelineValue={stats?.pipeline_value ?? 0}
              revenue={stats?.revenue ?? 0}
              money={money}
            />
          </div>

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
                  <tbody className="divide-y divide-[var(--border-default)]">
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
          </div>
        </>
      )}

      <Modal
        isOpen={addOpen}
        title={step === 4 ? 'Brand created' : `New venture · step ${step} of 3`}
        onClose={() => setAddOpen(false)}
        onSubmit={wizardNext}
        submitLabel={stepLabel}
        loading={creating}
      >
        <div className="space-y-4">
          {/* Step 1 — basics */}
          {step === 1 && (
            <div className="space-y-3">
              <Input label="Brand name" placeholder="e.g. RetentionRail" value={wName} onChange={(e) => setWName(e.target.value)} />
              <Textarea
                label="What is this brand about?"
                placeholder="One or two lines — what it does, who it's for. The AI uses this (plus your deck) to find the right leads."
                rows={3}
                value={wDesc}
                onChange={(e) => setWDesc(e.target.value)}
              />
              <p className="text-xs text-[var(--text-muted)]">A brand is a separate brand workspace — its own leads, sequences, inbox and outreach.</p>
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
                  PDF, PPTX, Word, or Excel. The AI reads it and, with your goal above, builds a tailored lead profile so LeadRail targets the right people.
                </p>
                {wDeck && <p className="mt-1 text-xs text-[var(--brand)]">Selected: {wDeck.name}</p>}
              </div>
              <div>
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Focus areas</span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setWSkills([AUTO_SKILLS])}
                    className={`rounded-full border px-3 py-1 text-xs transition ${wSkills.includes(AUTO_SKILLS) ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--brand)]'}`}
                  >
                    🤖 Automatic (recommended)
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
                <p className="mt-1 text-xs text-[var(--text-muted)]">LeadRail AI automatically picks the best approach for each task. Choose specific focus areas only to force them on.</p>
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
                  <p className="mb-1 text-xs font-semibold text-[var(--brand)]">AI brand profile</p>
                  <p className="text-sm text-[var(--text-secondary)]">{profileResult.summary}</p>
                </div>
              )}
              {profileResult?.note && <p className="text-xs text-[var(--text-muted)]">{profileResult.note}</p>}
              <p className="text-xs text-[var(--text-muted)]">Head to <b>Leads → Find Leads</b> — your LeadRail search is pre-filled from this profile.</p>
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

// First-run activation hero — shown to a signed-in operator who has no ventures
// yet, in place of a dead zeros dashboard. Its single job: launch the wizard.
function FirstRunHero({ onStart }: { onStart: () => void }) {
  const steps = [
    { n: 1, t: 'Name your brand', d: 'A brand is a self-contained brand workspace — its own leads, sequences, inbox and outreach.' },
    { n: 2, t: 'Set the target', d: 'Tell it who you sell to and which sectors — this shapes every lead search.' },
    { n: 3, t: 'Drop a deck (optional)', d: 'The AI reads your pitch and auto-tailors your LeadRail search to the right people.' },
  ];
  return (
    <div className="animate-fade-in overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
      {/* Banner */}
      <div className="relative overflow-hidden border-b border-[var(--border-default)] bg-[var(--bg-raised)] px-8 py-10">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-[var(--brand-soft)] blur-2xl" />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)]">
            Welcome aboard
          </span>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">Let's set up your first brand</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
            Your command center is empty until it has a venture to run. Spin one up in under a minute — then find leads, build sequences, and work the pipeline for it.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              onClick={onStart}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--ink)] px-5 py-2.5 text-sm font-semibold text-[var(--ink-fg)] shadow-[var(--shadow-card)] transition hover:bg-[var(--ink-hover)]"
            >
              Set up first venture →
            </button>
          </div>
        </div>
      </div>

      {/* What happens */}
      <div className="grid gap-4 px-8 py-7 sm:grid-cols-3">
        {steps.map((s) => (
          <div key={s.n} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] p-4">
            <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--brand-soft)] text-sm font-bold text-[var(--brand)]">{s.n}</div>
            <p className="text-sm font-semibold">{s.t}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{s.d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Pipeline-health panel — a token-driven proportion bar (open · won · lost)
// plus the three deal counts and the two money figures. Theme-correct.
function PipelineHealth({
  open,
  won,
  lost,
  pipelineValue,
  revenue,
  money,
}: {
  open: number;
  won: number;
  lost: number;
  pipelineValue: number;
  revenue: number;
  money: (n: number) => string;
}) {
  const total = open + won + lost;
  const rows = [
    { label: 'Open', n: open, color: 'var(--status-active)' },
    { label: 'Won', n: won, color: 'var(--status-positive)' },
    { label: 'Lost', n: lost, color: 'var(--status-negative)' },
  ];
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)]">
      <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">Pipeline health</h3>
      {total === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--text-muted)]">No deals yet.</p>
      ) : (
        <>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-raised)]">
            {rows.map((r) =>
              r.n > 0 ? (
                <div key={r.label} style={{ width: `${(r.n / total) * 100}%`, background: r.color }} title={`${r.label}: ${r.n}`} />
              ) : null,
            )}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                <div className="min-w-0">
                  <div className="text-lg font-bold leading-none text-[var(--text-primary)]">{r.n}</div>
                  <div className="text-[11px] text-[var(--text-secondary)]">{r.label}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--border-default)] pt-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">Open value</div>
              <div className="mt-0.5 text-base font-semibold text-[var(--text-primary)]">{money(pipelineValue)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">Won revenue</div>
              <div className="mt-0.5 text-base font-semibold" style={{ color: 'var(--status-positive)' }}>{money(revenue)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
