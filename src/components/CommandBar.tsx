'use client';
import { useState } from 'react';
import { apiSend } from '@/lib/api';

// Jarvis-style command bar. The operator types a task in natural language;
// Hermes routes it — deciding the intent, which skills apply, and which model
// tier handles it — and reports the plan. This is honest: it shows how the
// request WOULD be handled (intent + skills + model), not a faked execution.
interface HermesPlan {
  intent: string;
  taskKind: string;
  skillIds: string[];
  model: string;
  modelLabel: string;
  rationale: string;
  source: 'ai' | 'fallback';
}

const EXAMPLES = [
  'Find 25 SaaS founders in Toronto',
  'Draft a cold email for RetentionRail',
  'Build a 4-step outreach sequence',
];

export default function CommandBar({ ventureName }: { ventureName?: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<HermesPlan | null>(null);
  const [error, setError] = useState('');

  const run = async (q?: string) => {
    const request = (q ?? text).trim();
    if (!request || busy) return;
    setBusy(true); setError(''); setPlan(null);
    try {
      const { plan } = await apiSend<{ plan: HermesPlan }>('/api/hermes/route', 'POST', {
        request,
        ventureName: ventureName && ventureName !== 'All Ventures' ? ventureName : undefined,
      });
      setPlan(plan);
    } catch (e: any) {
      setError(e?.message || 'Hermes could not route that.');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
      {/* Prompt row */}
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--brand)]" />
        </span>
        <span className="hidden shrink-0 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] sm:block">
          Hermes
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          disabled={busy}
          placeholder={busy ? 'Routing…' : 'Ask Hermes to route a task — e.g. “find 25 SaaS founders in Toronto”'}
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none disabled:opacity-60"
        />
        <button
          onClick={() => run()}
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-lg bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Routing…' : 'Route ▸'}
        </button>
      </div>

      {/* Example chips (only before first run) */}
      {!plan && !error && !busy && (
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => { setText(ex); run(ex); }}
              className="rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-secondary)] transition hover:border-[var(--brand)] hover:text-[var(--brand)]"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--status-negative)]">
          {error}
        </p>
      )}

      {/* The routing plan */}
      {plan && (
        <div className="mt-3 animate-fade-in rounded-xl border border-[var(--border-default)] bg-[var(--bg-raised)] p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--brand-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--brand)]">
              {prettyIntent(plan.intent)}
            </span>
            <span className="text-xs text-[var(--text-muted)]">routed to</span>
            <span className="rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)]">
              {plan.modelLabel}
            </span>
            <span
              title={plan.source === 'ai' ? 'Hermes reasoned this route with a model' : 'Deterministic keyword fallback'}
              className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${plan.source === 'ai' ? 'bg-[var(--brand-soft)] text-[var(--brand)]' : 'bg-[var(--bg-surface)] text-[var(--text-muted)]'}`}
            >
              {plan.source === 'ai' ? 'AI routed' : 'Rule routed'}
            </span>
          </div>

          {plan.rationale && (
            <p className="mt-2.5 text-sm leading-relaxed text-[var(--text-secondary)]">{plan.rationale}</p>
          )}

          {plan.skillIds?.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {plan.skillIds.map((s) => (
                <span key={s} className="rounded-md bg-[var(--bg-surface)] px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]">
                  {s.replace(/^skill-/, '')}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function prettyIntent(intent: string) {
  return intent.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
